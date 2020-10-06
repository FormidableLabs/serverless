'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const globby = require('globby');
const BbPromise = require('bluebird');
const _ = require('lodash');
const normalizeFiles = require('../../lib/normalizeFiles');

module.exports = {
  checkForChanges() {
    this.serverless.service.provider.shouldNotDeploy = false;

    if (this.options.force) {
      return this.checkLogGroupSubscriptionFilterResourceLimitExceeded();
    }

    return BbPromise.bind(this)
      .then(this.getMostRecentObjects)
      .then(objs => {
        return BbPromise.all([
          this.getObjectMetadata(objs),
          this.getFunctionsEarliestLastModifiedDate(),
        ]);
      })
      .then(([objs, lastModifiedDate]) =>
        this.checkIfDeploymentIsNecessary(objs, lastModifiedDate)
      )
      .then(() => {
        if (this.serverless.service.provider.shouldNotDeploy) {
          return BbPromise.resolve();
        }

        // perform the subscription filter checking only if a deployment is required
        return this.checkLogGroupSubscriptionFilterResourceLimitExceeded();
      });
  },

  getMostRecentObjects() {
    const service = this.serverless.service.service;

    const params = {
      Bucket: this.bucketName,
      Prefix: `${this.provider.getDeploymentPrefix()}/${service}/${this.provider.getStage()}`,
    };

    return this.provider
      .request('S3', 'listObjectsV2', params)
      .catch(reason => {
        if (!reason.message.includes('The specified bucket does not exist')) {
          return BbPromise.reject(reason);
        }
        const stackName = this.provider.naming.getStackName();
        return BbPromise.reject(
          new this.serverless.classes.Error(
            [
              `The serverless deployment bucket "${params.Bucket}" does not exist.`,
              `Create it manually if you want to reuse the CloudFormation stack "${stackName}",`,
              'or delete the stack if it is no longer required.',
            ].join(' ')
          )
        );
      })
      .then(result => {
        if (result && result.Contents && result.Contents.length) {
          const objects = result.Contents;

          const ordered = _.orderBy(objects, ['Key'], ['desc']);

          const firstKey = ordered[0].Key;
          const directory = firstKey.substring(0, firstKey.lastIndexOf('/'));

          const mostRecentObjects = ordered.filter(obj => {
            const objKey = obj.Key;
            const objDirectory = objKey.substring(0, objKey.lastIndexOf('/'));

            return directory === objDirectory;
          });

          return BbPromise.resolve(mostRecentObjects);
        }

        return BbPromise.resolve([]);
      });
  },

  // Gives the least recent last modify date across all the functions in the service.
  getFunctionsEarliestLastModifiedDate() {
    const getFunctionResults = this.serverless.service.getAllFunctions().map(funName => {
      const functionObj = this.serverless.service.getFunction(funName);
      return this.provider
        .request('Lambda', 'getFunction', {
          FunctionName: functionObj.name,
        })
        .then(res => new Date(res.Configuration.LastModified))
        .catch(() => new Date(0)); // Function is missing, needs to be deployed
    });

    return BbPromise.all(getFunctionResults).then(results =>
      results.reduce((currentMin, date) => {
        if (!currentMin || date < currentMin) return date;
        return currentMin;
      }, null)
    );
  },

  getObjectMetadata(objects) {
    if (objects && objects.length) {
      const headObjectObjects = objects.map(obj =>
        this.provider.request('S3', 'headObject', {
          Bucket: this.bucketName,
          Key: obj.Key,
        })
      );

      return BbPromise.all(headObjectObjects).then((result) => {
        return result.map((headObjectObject, i) => {
          return {
            Key: objects[i].Key,
            Metadata: headObjectObject.Metadata
          };
        });
      });
    }

    return BbPromise.resolve([]);
  },

  checkIfDeploymentIsNecessary(objects, funcLastModifiedDate) {
    if (objects && objects.length) {
      const serverlessDirPath = path.join(this.serverless.config.servicePath, '.serverless');

      // create a hash of the CloudFormation body
      const compiledCfTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;
      const normCfTemplate = normalizeFiles.normalizeCloudFormationTemplate(compiledCfTemplate);
      const localCfHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(normCfTemplate))
        .digest('base64');

      // create hashes for all the zip files
      const zipFiles = globby.sync(['**.zip'], { cwd: serverlessDirPath, dot: true, silent: true });
      const zipFilePaths = zipFiles.map(zipFile => path.resolve(serverlessDirPath, zipFile));
      if (this.serverless.service.package.artifact) {
        // TODO(RYAN): Handle this case, as the relative path might not be correct.

        // Add explicit artifacts if not already included in the `.zip` globbing.
        // Plugins / user scripting _can_ output `.zip` files to the target `.serverless` directory
        // and we don't want them doubly included which wastes I/O and could throw off hash matching.
        const pkgArtifactPath = path.resolve(this.serverless.config.servicePath, this.serverless.service.package.artifact);
        if (!zipFilePaths.includes(pkgArtifactPath)) {
          zipFilePaths.push(pkgArtifactPath);
        }
      }

      const readFile = BbPromise.promisify(fs.readFile);
      const zipFileHashesPromises = zipFilePaths.map(zipFilePath =>
        readFile(zipFilePath).then(zipFile =>
          crypto
            .createHash('sha256')
            .update(zipFile)
            .digest('base64')
        )
      );

      return BbPromise.all(zipFileHashesPromises).then(zipFileHashes => {
        // Create maps of local + remote artifact relative paths to hashes.
        const localMap = zipFilePaths.reduce((memo, zipFilePath, i) => {
          // Normalize file path to relative to serverless artifact directory.
          const filePath = path.relative(serverlessDirPath, zipFilePath);
          memo[filePath] = zipFileHashes[i];
          return memo;
        }, {
          // Start with a simulation of what the compiled CF template should be.
          [this.provider.naming.getCompiledTemplateS3Suffix()]: localCfHash
        });
        const remoteMap = Object.values(objects).reduce((memo, obj) => {
          // Normalize file path to after last slash per other logic in this file.
          const filePath = obj.Key.substring(obj.Key.lastIndexOf('/') + 1);
          memo[filePath] = obj.Metadata.filesha256 || '';
          return memo;
        }, {});

        // If any objects were changed after the last time the function was updated
        // there could have been a failed deploy.
        const changedAfterDeploy = objects.some(object => {
          return object.LastModified && object.LastModified > funcLastModifiedDate;
        });

        // TODO: HERE -- Need something that indicates:
        // 1. Type: CF, Function, Layer
        // 2. Then refactor conditional logic to handle "just layer changes".
        // Create maps of artifact relative paths to zip names.
        const layersMap = this.serverless.service.getAllLayers().reduce((memo, layerName) => {
          memo[`${layerName}.zip`] = layerName;
          return memo;
        }, {});

        console.log('TODO HERE', JSON.stringify({
          localMap,
          remoteMap,
          isEqual: _.isEqual(localMap, remoteMap),
          layersMap
        }, null, 2));

        if (!changedAfterDeploy) {
          // Check if **all** resources are unchanged (CF template, functions, layers).
          // If so, set global "don't deploy" flag.
          if (_.isEqual(localMap, remoteMap)) {
            this.serverless.service.provider.shouldNotDeploy = true;

            const message = ['Service files not changed. Skipping deployment...'].join('');
            this.serverless.cli.log(message, 'Serverless', { color: 'orange' });
          } else {

            // If the CF template hasn't changed, then check if only some functions /
            // layers have changed.
            // TODO: Check CF TEMPLATE CHANGES OUTER IF
            // TODO: Check Some Layers unchanged -- mutate
            // TODO: After mutation, check that the CF normalized hash is updated (?).
            // TODO TICKET: Check some functions unchanged -- mutate
          }
        }
      });
    }

    return BbPromise.resolve();
  },

  /**
   * @description Cloudwatch imposes a hard limit of 1 subscription filter per log group.
   * If we change a cloudwatchLog event entry to add a subscription filter to a log group
   * that already had one before, it will throw an error because CloudFormation firstly
   * tries to create and replace the new subscription filter (therefore hitting the limit)
   * before deleting the old one. This precompile process aims to delete existent
   * subscription filters of functions that a new filter was provided, by checking the
   * current ARN with the new one that will be generated.
   * See: https://git.io/fpKCM
   */
  checkLogGroupSubscriptionFilterResourceLimitExceeded() {
    const region = this.provider.getRegion();
    const cloudWatchLogsSdk = new this.provider.sdk.CloudWatchLogs({ region });

    return this.provider.getAccountInfo().then(account =>
      Promise.all(
        this.serverless.service.getAllFunctions().map(functionName => {
          const functionObj = this.serverless.service.getFunction(functionName);

          if (!functionObj.events) {
            return BbPromise.resolve();
          }

          let logSubscriptionSerialNumber = 0;
          const promises = functionObj.events.map(event => {
            if (!event.cloudwatchLog) {
              return BbPromise.resolve();
            }

            let logGroupName;

            /*
              it isn't necessary to run sanity checks here as they already happened during the
              compile step
            */
            if (typeof event.cloudwatchLog === 'object') {
              logGroupName = event.cloudwatchLog.logGroup.replace(/\r?\n/g, '');
            } else {
              logGroupName = event.cloudwatchLog.replace(/\r?\n/g, '');
            }

            const accountId = account.accountId;
            const partition = account.partition;

            logSubscriptionSerialNumber++;

            /*
              return a new promise that will check the resource limit exceeded and will fix it if
              the option is enabled
            */
            return this.fixLogGroupSubscriptionFilters({
              cloudWatchLogsSdk,
              accountId,
              logGroupName,
              functionName,
              functionObj,
              region,
              partition,
              logSubscriptionSerialNumber,
            });
          });

          return Promise.all(promises);
        })
      )
    );
  },

  fixLogGroupSubscriptionFilters(params) {
    const cloudWatchLogsSdk = params.cloudWatchLogsSdk;
    const accountId = params.accountId;
    const logGroupName = params.logGroupName;
    const functionName = params.functionName;
    const functionObj = params.functionObj;
    const region = params.region;
    const partition = params.partition;
    const logSubscriptionSerialNumber = params.logSubscriptionSerialNumber;

    return (
      cloudWatchLogsSdk
        .describeSubscriptionFilters({ logGroupName })
        .promise()
        .then(response => {
          const subscriptionFilter = response.subscriptionFilters[0];

          // log group doesn't have any subscription filters currently
          if (!subscriptionFilter) {
            return false;
          }

          const filterName = subscriptionFilter.filterName;

          const oldDestinationArn = subscriptionFilter.destinationArn;
          const newDestinationArn = `arn:${partition}:lambda:${region}:${accountId}:function:${functionObj.name}`;

          const oldLogicalId = this.getLogicalIdFromFilterName(filterName);
          const newLogicalId = this.provider.naming.getCloudWatchLogLogicalId(
            functionName,
            logSubscriptionSerialNumber
          );

          // everything is fine, just return
          if (oldDestinationArn === newDestinationArn && oldLogicalId === newLogicalId) {
            return false;
          }

          /*
            If the destinations functions' ARNs doesn't match, we need to delete the current
            subscription filter to prevent the resource limit exceeded error to happen
          */
          return cloudWatchLogsSdk.deleteSubscriptionFilter({ logGroupName, filterName }).promise();
        })
        /*
        it will throw when trying to get subscription filters of a log group that was just added
        to the serverless.yml (therefore not created in AWS yet), we can safely ignore this error
      */
        .catch(() => undefined)
    );
  },

  getLogicalIdFromFilterName(filterName) {
    // Filter name format:
    // {stack name}-{logical id}-{random alphanumeric characters}
    // Note that the stack name can include hyphens
    const split = filterName.split('-');
    return split[split.length - 2];
  },
};
