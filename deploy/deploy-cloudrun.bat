@echo off
rem Deploy CamHub to Google Cloud Run (Windows).
rem Usage: deploy\deploy-cloudrun.bat [--project ID] [--region REGION] [--update-secrets] [--skip-setup] [--dry-run] [--yes]
setlocal

cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is required ^(https://nodejs.org^). 1>&2
    exit /b 1
)
where gcloud >nul 2>nul
if errorlevel 1 (
    echo Google Cloud CLI is required: https://cloud.google.com/sdk/docs/install 1>&2
    exit /b 1
)

node deploy\deploy-cloudrun.js %*
exit /b %ERRORLEVEL%
