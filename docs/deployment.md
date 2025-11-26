# Google Cloud Run Deployment Guide

This guide describes how to deploy the Vonage MCP Server (HTTP Wrapper) to Google Cloud Run.

## Prerequisites

1.  **Google Cloud Project**: Create a project with billing enabled.
2.  **gcloud CLI**: Install and authenticate (`gcloud auth login`).
3.  **APIs Enabled**: Enable Cloud Run and Secret Manager APIs.
    ```bash
    gcloud services enable run.googleapis.com secretmanager.googleapis.com
    ```

## Deployment Steps

### 1. Set Environment Variables

Set your project ID and region for convenience.

```bash
export PROJECT_ID="your-project-id"
export REGION="asia-northeast1" # e.g., Tokyo
export SERVICE_NAME="vonage-mcp-server"
```

### 2. Upload Private Key to Secret Manager

Upload your `private.key` file to Google Secret Manager.

```bash
gcloud secrets create vonage-private-key --data-file="./private.key" --project=$PROJECT_ID
```

### 3. Deploy to Cloud Run

Deploy the application using `gcloud run deploy`.
Replace `YOUR_APPLICATION_ID` and `YOUR_VOICE_FROM_NUMBER` with your actual values.

```bash
gcloud run deploy $SERVICE_NAME \
  --source . \
  --project $PROJECT_ID \
  --region $REGION \
  --allow-unauthenticated \
  --set-env-vars="VONAGE_APPLICATION_ID=YOUR_APPLICATION_ID" \
  --set-env-vars="VONAGE_VOICE_FROM=YOUR_VOICE_FROM_NUMBER" \
  --set-env-vars="VONAGE_PRIVATE_KEY_PATH=/secrets/private.key" \
  --set-secrets="/secrets/private.key=vonage-private-key:latest"
```

**Explanation of flags:**
*   `--source .`: Builds the container image from the current directory using the Dockerfile.
*   `--allow-unauthenticated`: Allows public access to the service URL (Authentication is handled by the application via `X-API-KEY`).
*   `--set-env-vars`: Sets environment variables.
*   `--set-secrets`: Mounts the secret `vonage-private-key` to the file path `/secrets/private.key` inside the container.

### 4. Verify Deployment

After deployment, you will get a Service URL (e.g., `https://vonage-mcp-server-xyz-an.a.run.app`).

Verify it works:

```bash
# Health check (No auth required)
curl https://YOUR_SERVICE_URL/health

# Tool invocation (Auth required)
curl -X POST https://YOUR_SERVICE_URL/mcp-invoke \
  -H "Content-Type: application/json" \
  -H "X-API-KEY: YOUR_APPLICATION_ID" \
  -d '{"tool": "send_sms", "params": {"to": "...", "message": "Hello"}}'
```
