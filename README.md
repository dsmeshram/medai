# FDA API Server

This is an HTTP server that exposes the OpenFDA API calling functionality.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the project:
   ```bash
   npm run build
   ```

3. Set your OpenFDA API key in `.env`:
   ```
   OPENFDA_API_KEY=your_api_key_here
   ```

## Running the Server

To start the HTTP server:
```bash
npm start
```

The server will run on http://localhost:8000.

## Endpoints

- `GET /health`: Health check endpoint
- `POST /call-tool`: Call the OpenFDA API

  Request body:
  ```json
  {
    "endpoint": "/drug/event.json",
    "params": {
      "search": "aspirin",
      "limit": 10
    }
  }
  ```

  Response: JSON data from the FDA API

## OpenAI Compatibility

This server provides an HTTP API that can be integrated with OpenAI's tool calling by making HTTP requests to the `/call-tool` endpoint.

## Ngrok

To expose the server publicly, use ngrok:
```bash
ngrok http 8000
```

Then use the ngrok URL in your OpenAI tool configuration.