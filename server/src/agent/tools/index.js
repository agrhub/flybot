const { cameraDeclarations, cameraExecutors } = require('./cameraTools');
const { analyticsDeclarations, analyticsExecutors } = require('./analyticsTools');
const { navigationDeclarations, navigationExecutors } = require('./navigationTools');
const { operationsDeclarations, operationsExecutors } = require('./operationsTools');

const allFunctionDeclarations = [
    ...cameraDeclarations,
    ...analyticsDeclarations,
    ...operationsDeclarations,
    ...navigationDeclarations
];

const allExecutors = {
    ...cameraExecutors,
    ...analyticsExecutors,
    ...operationsExecutors,
    ...navigationExecutors
};

module.exports = {
    allFunctionDeclarations,
    allExecutors
};
