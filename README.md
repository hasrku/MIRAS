# MIRAS — VLM-Powered Graph-RAG with Human-in-the-Loop

MIRAS is a multimodal document question-answering system that combines **Visual Language Models (VLMs), Retrieval-Augmented Generation (RAG), and a knowledge graph** to understand PDF documents.

It extracts document elements such as text, tables, figures, and images, connects related elements in a multimodal knowledge graph, and uses graph-guided retrieval to answer user questions with source references.

## Features

- **Multimodal PDF understanding:** Extracts text, tables, figures, and visual elements from PDFs.
- **Knowledge graph:** Represents document elements as nodes and connects them using reading order, text similarity, and visual similarity.
- **Graph-guided RAG:** Retrieves relevant document elements and generates context-aware answers using a vision-language model.
- **Interactive 3D graph:** Explore document entities and their relationships.
- **Source navigation:** Open cited elements in the original PDF.
- **Human-in-the-loop feedback:** Submit corrections that are added to the knowledge graph.
- **Persistent storage:** Stores the graph, embeddings, document metadata, crops, and PDF using ChromaDB.

## Tech Stack

| Component                 | Technologies                                              |
| ------------------------- | --------------------------------------------------------- |
| Frontend                  | React, Vite, Tailwind CSS, Three.js, react-force-graph-3d |
| Backend                   | Python, FastAPI, Uvicorn                                  |
| VLM                       | Qwen2.5-VL-7B-Instruct                                    |
| Visual embeddings         | CLIP ViT-L/14                                             |
| Text embeddings           | BAAI/bge-base-en-v1.5                                     |
| Document processing       | Docling, pdfplumber, pdf2image                            |
| Knowledge graph           | NetworkX                                                  |
| Vector/persistent storage | ChromaDB                                                  |
| API tunnelling            | ngrok                                                     |

## Project Setup

### 1. Clone the repository

```bash
git clone https://github.com/hasrku/MIRAS.git
cd MIRAS
```

### 2. Backend Setup (Google Colab)

The backend and model pipeline run in Google Colab. A GPU-enabled runtime is required because the notebook loads CLIP and Qwen2.5-VL on CUDA.

1. Open `V4_graph_vlm_rag_HIL.ipynb` in Google Colab.
2. Select **Runtime → Change runtime type → T4 GPU** (or another compatible GPU).
3. Run the notebook's dependency installation and model-loading cells.
4. Run the document-processing, embedding, graph, and Graph-RAG function-definition cells.
5. Run the **Persistent knowledge-graph store (ChromaDB)** cell.
6. Run the **FastAPI Backend setup** cell to start the API and ngrok tunnel.

Do not run the sample-PDF/interactive CLI cells unless you specifically want to test the notebook pipeline separately. The frontend uploads PDFs through the FastAPI `/upload` endpoint.

#### Configure ngrok securely

1. Get an authentication token from the [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken).
2. In the FastAPI cell, load the token and paste it in this:

```python
# Load the token from Colab Secrets (key: NGROK_AUTH_TOKEN) or an env var.

ngrok.set_auth_token("YOUR_NGROK_TOKEN")
```

The notebook prints the public ngrok URL after the server starts. Keep the Colab runtime running while using the application.

### 3. Frontend Setup

Open a terminal in the frontend directory (the directory containing `package.json`).

Install dependencies:

```bash
npm install
```

Create a `.env` file in the frontend root and add the public ngrok URL printed by the backend:

```env
VITE_API_URL=https://YOUR-NGROK-URL.ngrok-free.app
```

Start the frontend:

```bash
npm run dev
```

Open the local URL printed by Vite (usually `http://localhost:5173`).

> Restart the Vite development server whenever you change `.env`.

## API Endpoints

| Method | Endpoint        | Purpose                                               |
| ------ | --------------- | ----------------------------------------------------- |
| `GET`  | `/`             | Backend status                                        |
| `GET`  | `/status`       | Pipeline and graph status                             |
| `POST` | `/upload`       | Upload and index a PDF                                |
| `GET`  | `/graph`        | Retrieve the active knowledge graph                   |
| `GET`  | `/pdf/{doc_id}` | Retrieve the stored PDF                               |
| `POST` | `/query`        | Ask a question about the document (streamed response) |
| `POST` | `/feedback`     | Submit a correction and update the graph              |
| `POST` | `/reset`        | Delete stored documents and graph data                |

## Notes

- The backend must be running in Colab before using the frontend.
- Colab runtimes and ngrok URLs can change. Update `VITE_API_URL` when the tunnel URL changes.
- Do not commit API keys, ngrok tokens, `.env` files, or other credentials.
- The current backend CORS configuration allows all origins; restrict it to your frontend domain before deploying beyond development.
