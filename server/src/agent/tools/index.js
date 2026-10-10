const { cameraDeclarations, cameraExecutors } = require('./cameraTools');
const { analyticsDeclarations, analyticsExecutors } = require('./analyticsTools');
const { navigationDeclarations, navigationExecutors } = require('./navigationTools');

const allFunctionDeclarations = [
    ...cameraDeclarations,
    ...analyticsDeclarations,
    ...navigationDeclarations
];

const allExecutors = {
    ...cameraExecutors,
    ...analyticsExecutors,
    ...navigationExecutors
};

module.exports = {
    allFunctionDeclarations,
    allExecutors
};
