'use strict';

const _ = require('lodash');

module.exports = {
  normalizeCloudFormationTemplate(template) {
    const normalizedTemplate = _.cloneDeep(template);

    Object.entries(normalizedTemplate.Resources).forEach(([key, value]) => {
      if (key.startsWith('ApiGatewayDeployment')) {
        delete Object.assign(normalizedTemplate.Resources, {
          ApiGatewayDeployment: normalizedTemplate.Resources[key],
        })[key];
      }
      if (key.startsWith('WebsocketsDeployment') && key !== 'WebsocketsDeploymentStage') {
        delete Object.assign(normalizedTemplate.Resources, {
          WebsocketsDeployment: normalizedTemplate.Resources[key],
        })[key];
      }
      if (key === 'WebsocketsDeploymentStage') {
        const newVal = value;
        newVal.Properties.DeploymentId.Ref = 'WebsocketsDeployment';
      }
      if (value.Type && value.Type === 'AWS::Lambda::Function') {
        const newVal = value;
        newVal.Properties.Code.S3Key = '';
      }
      if (value.Type && value.Type === 'AWS::Lambda::LayerVersion') {
        const newVal = value;
        newVal.Properties.Content.S3Key = '';
      }
    });

    Object.entries(normalizedTemplate.Outputs).forEach(([key, value]) => {
      // Remove timestamped value in:
      // ```
      // "<NAME>LayerS3Key": {
      //   "Description": "Current <NAME> layer S3Key",
      //   "Value": "serverless/<SERVICE>/<ENV>/<TIMESTAMP>/<NAME>.zip"
      // },
      // ```
      if (key.endsWith('S3Key')) {
        const newVal = value;
        newVal.Value = '';
      }
    });

    return normalizedTemplate;
  },
};
