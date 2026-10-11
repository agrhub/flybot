const { cameraDeclarations, cameraExecutors } = require('./cameraTools');
const { analyticsDeclarations, analyticsExecutors } = require('./analyticsTools');
const { navigationDeclarations, navigationExecutors } = require('./navigationTools');
const { operationsDeclarations, operationsExecutors } = require('./operationsTools');
const { actionDeclarations, actionExecutors } = require('./actionTools');

const allFunctionDeclarations = [
    ...cameraDeclarations,
    ...analyticsDeclarations,
    ...operationsDeclarations,
    ...actionDeclarations,
    ...navigationDeclarations
];

const allExecutors = {
    ...cameraExecutors,
    ...analyticsExecutors,
    ...operationsExecutors,
    ...actionExecutors,
    ...navigationExecutors
};

module.exports = {
    allFunctionDeclarations,
    allExecutors
};
