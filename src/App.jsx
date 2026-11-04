import React, { useState, useRef, useEffect, useCallback } from "react";
import {
    Upload,
    Send,
    FileText,
    Bot,
    Loader2,
    Zap,
    Network,
    MessageSquare,
    X,
    ChevronLeft,
    ChevronRight,
    Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ForceGraph3D from "react-force-graph-3d";
import SpriteText from "three-spritetext";
import * as THREE from "three";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const API_BASE = import.meta.env.VITE_API_URL;

// ngrok's free tier injects an HTML warning page unless this header is sent.
const NGROK_HEADERS = { "ngrok-skip-browser-warning": "true" };

// Chats live in localStorage only; the knowledge graph + PDF live on the backend.
const CHAT_KEY = "miras_chat_v1";
const loadSavedChat = () => {
    try {
        const raw = localStorage.getItem(CHAT_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
};
const saveChat = (docId, chat) => {
    try {
        localStorage.setItem(CHAT_KEY, JSON.stringify({ docId, chat }));
    } catch {
        /* storage full or unavailable - ignore */
    }
};
const clearSavedChat = () => {
    try {
        localStorage.removeItem(CHAT_KEY);
    } catch {
        /* ignore */
    }
};
const WELCOME_MSG = {
    role: "bot",
    content:
        "PDF indexed successfully! I've also generated a 3D Knowledge Graph of your document. What would you like to know?",
};

// Shared Three.js resources (created once, reused by every node)
const SPHERE_GEO = new THREE.SphereGeometry(6, 16, 16);
const MAT_DEFAULT = new THREE.MeshLambertMaterial({ color: "#3b82f6", transparent: true, opacity: 0.95 });
const MAT_CITED = new THREE.MeshLambertMaterial({ color: "#f59e0b", transparent: true, opacity: 1 });
const MAT_CORRECTION = new THREE.MeshLambertMaterial({ color: "#a855f7", transparent: true, opacity: 1 });

// ---------- helpers ----------
const escapeHtml = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Convert the pipe-delimited text commonly returned by PDF table extraction
// into rows that can be rendered as an actual HTML table.
const parseExtractedTable = (value = "") => {
    const lines = String(value)
        .replace(/```(?:text|markdown)?/gi, "")
        .replace(/```/g, "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const rows = [];
    lines.forEach((line) => {
        // Ignore Markdown-style table separator rows (|---|:---:|).
        const compact = line.replace(/[|+\-:.\s]/g, "");
        if (!compact) return;

        let cells;
        if (line.includes("|")) {
            cells = line
                .split("|")
                .map((cell) => cell.trim())
                .filter((cell, index, all) => {
                    // Drop the empty cells created by leading/trailing pipe characters.
                    return !(cell === "" && (index === 0 || index === all.length - 1));
                });
        } else {
            cells = [line];
        }

        if (cells.length) rows.push(cells);
    });

    // Some extractors put the entire table on one line. Split it into cells
    // while retaining the same rendering path.
    if (rows.length === 1 && rows[0].length === 1 && String(value).includes("|")) {
        const cells = String(value)
            .split("|")
            .map((cell) => cell.trim())
            .filter(Boolean);
        if (cells.length > 1) return [cells];
    }

    return rows;
};

const isTableEntity = (entity) =>
    String(entity?.element_type ?? entity?.type ?? "")
        .toLowerCase()
        .includes("table");

const tableHtml = (value = "") => {
    const rows = parseExtractedTable(value);
    if (!rows.length) return `<div style="color:#a1a1aa">${escapeHtml(value)}</div>`;

    return `
        <div style="max-width:100%;overflow-x:auto;margin-top:6px">
            <table style="width:100%;border-collapse:collapse;font-size:11px;line-height:1.4;color:#e4e4e7">
                <tbody>
                    ${rows
                        .map(
                            (row, rowIndex) => `
                        <tr>
                            ${row
                                .map((cell) =>
                                    rowIndex === 0
                                        ? `<th style="padding:6px 8px;text-align:left;vertical-align:top;background:#27272a;border:1px solid #52525b;color:#f4f4f5;font-weight:600">${escapeHtml(cell)}</th>`
                                        : `<td style="padding:6px 8px;text-align:left;vertical-align:top;border:1px solid #3f3f46;overflow-wrap:anywhere">${escapeHtml(cell)}</td>`,
                                )
                                .join("")}
                        </tr>
                    `,
                        )
                        .join("")}
                </tbody>
            </table>
        </div>`;
};

const EntityTextContent = ({ entity }) => {
    const content = entity?.text || "";
    if (!content) {
        return <p className="text-xs text-zinc-500">No text content is available for this element.</p>;
    }

    if (isTableEntity(entity)) {
        const rows = parseExtractedTable(content);
        if (rows.length) {
            return (
                <div className="mt-3 max-h-52 overflow-auto rounded-lg border border-zinc-800">
                    <table className="w-full min-w-max border-collapse text-xs text-zinc-300">
                        <tbody>
                            {rows.map((row, rowIndex) => (
                                <tr key={rowIndex} className={rowIndex === 0 ? "bg-zinc-800/90" : "bg-zinc-900/40"}>
                                    {row.map((cell, cellIndex) => {
                                        const Cell = rowIndex === 0 ? "th" : "td";
                                        return (
                                            <Cell
                                                key={cellIndex}
                                                className="border border-zinc-700 px-3 py-2 text-left align-top font-normal leading-relaxed whitespace-normal"
                                            >
                                                {cell}
                                            </Cell>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
        }
    }

    return (
        <p className="mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-300">
            {content}
        </p>
    );
};

// Normalise a source (chat citation) or graph node into what the PDF viewer needs
const toCite = (item) => ({
    id: item.id,
    page: Number(item.page ?? item.page_num) || 1, // expects 1-based
    bbox: item.bbox || null,
    bbox_norm: item.bbox_norm || null,
    page_width: item.page_width,
    page_height: item.page_height,
});

// Convert bbox -> percentages of the page (resolution independent)
const typeLabel = (n) => String(n?.element_type ?? n?.type ?? "element");
const pageOf = (n) => n?.page ?? n?.page_num ?? "?";

// bbox -> % of page. `pdf` = {w, h} page size in PDF points, measured by pdf.js
const getBoxStyle = (c, pdf) => {
    const n = c?.bbox_norm;
    if (Array.isArray(n) && n.length === 4 && n.every(Number.isFinite)) {
        const [l, t, r, b] = n;
        return {
            left: `${l * 100}%`,
            top: `${t * 100}%`,
            width: `${Math.max(r - l, 0.005) * 100}%`,
            height: `${Math.max(b - t, 0.005) * 100}%`,
        };
    }

    const raw = c?.bbox;
    if (!raw) return null;

    let x0, y0, x1, y1;
    let bottomLeft = false;
    if (Array.isArray(raw)) {
        [x0, y0, x1, y1] = raw.map(Number);
    } else {
        x0 = Number(raw.l ?? raw.x0);
        y0 = Number(raw.t ?? raw.y0);
        x1 = Number(raw.r ?? raw.x1);
        y1 = Number(raw.b ?? raw.y1);
        bottomLeft = String(raw.coord_origin || "")
            .toUpperCase()
            .includes("BOTTOMLEFT");
    }
    if (![x0, y0, x1, y1].every(Number.isFinite)) return null;

    let W, H;
    const maxX = Math.max(x0, x1);
    const maxY = Math.max(y0, y1);

    if (bottomLeft) {
        // Docling BOTTOMLEFT coords are always PDF points: flip y using the real page height
        if (!pdf) return null;
        W = pdf.w;
        H = pdf.h;
        y0 = H - y0;
        y1 = H - y1;
    } else {
        const bw = Number(c.page_width);
        const bh = Number(c.page_height);
        if (maxX <= 1.01 && maxY <= 1.01) {
            W = 1;
            H = 1; // already fractions
        } else if (bw > 0 && bh > 0 && maxX <= bw * 1.01 && maxY <= bh * 1.01) {
            W = bw;
            H = bh; // backend-provided page size
        } else if (pdf && maxX <= pdf.w * 1.01 && maxY <= pdf.h * 1.01) {
            W = pdf.w;
            H = pdf.h; // PDF points
        } else {
            console.warn("bbox does not fit any known page size", c);
            return null;
        }
    }

    const clamp = (v) => Math.min(1, Math.max(0, v));
    const l = clamp(Math.min(x0, x1) / W);
    const r = clamp(Math.max(x0, x1) / W);
    const t = clamp(Math.min(y0, y1) / H);
    const b = clamp(Math.max(y0, y1) / H);

    return {
        left: `${l * 100}%`,
        top: `${t * 100}%`,
        width: `${Math.max(r - l, 0.005) * 100}%`,
        height: `${Math.max(b - t, 0.005) * 100}%`,
    };
};

// ---------- PDF viewer with highlight ----------
const PdfPageView = ({ url, cite }) => {
    const canvasRef = useRef(null);
    const boxRef = useRef(null);
    const [doc, setDoc] = useState(null);
    const [page, setPage] = useState(cite.page || 1);
    const [dims, setDims] = useState(null); // PDF page size in points

    useEffect(() => {
        setPage(cite.page || 1);
    }, [cite]);

    // Load document once per URL
    // Load document once per URL
    useEffect(() => {
        let cancelled = false;
        const task = pdfjsLib.getDocument({ url, httpHeaders: NGROK_HEADERS });
        task.promise
            .then((d) => {
                if (!cancelled) setDoc(d);
            })
            .catch((e) => {
                if (!cancelled) console.error("PDF load failed", e);
            });
        return () => {
            cancelled = true;
            task.destroy();
        };
    }, [url]);

    // Render current page
    useEffect(() => {
        if (!doc) return;
        let cancelled = false;
        let renderTask;
        (async () => {
            const p = Math.min(Math.max(1, page), doc.numPages);
            const pg = await doc.getPage(p);
            if (cancelled || !canvasRef.current) return;

            const base = pg.getViewport({ scale: 1 });
            setDims({ w: base.width, h: base.height });

            const viewport = pg.getViewport({ scale: 1.5 });
            const canvas = canvasRef.current;
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            renderTask = pg.render({ canvasContext: canvas.getContext("2d"), viewport });
            try {
                await renderTask.promise;
            } catch {
                return; // cancelled
            }
            if (!cancelled) boxRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
        })();
        return () => {
            cancelled = true;
            renderTask?.cancel();
        };
    }, [doc, page]);

    const boxStyle = page === cite.page ? getBoxStyle(cite, dims) : null;
    const missingBox = page === cite.page && cite.id && !boxStyle && dims;

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-center gap-3 py-2 border-b border-zinc-800 text-xs text-zinc-400">
                <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="p-1 rounded bg-zinc-800 hover:bg-zinc-700"
                >
                    <ChevronLeft size={14} />
                </button>
                Page {page}
                {doc ? ` / ${doc.numPages}` : ""}
                <button
                    onClick={() => setPage((p) => Math.min(doc?.numPages || p, p + 1))}
                    className="p-1 rounded bg-zinc-800 hover:bg-zinc-700"
                >
                    <ChevronRight size={14} />
                </button>
                {cite.id && page === cite.page && <span className="ml-2 text-red-400 font-mono">{cite.id}</span>}
                {missingBox && <span className="ml-2 text-amber-400">(no bounding box for this element)</span>}
            </div>
            <div className="flex-1 overflow-auto p-4">
                <div className="relative w-full max-w-4xl mx-auto bg-white">
                    <canvas ref={canvasRef} className="w-full h-auto block" />
                    {boxStyle && (
                        <div
                            ref={boxRef}
                            className="absolute border-2 border-dotted border-red-500 bg-red-500/5 rounded-sm pointer-events-none"
                            style={boxStyle}
                        />
                    )}
                </div>
            </div>
        </div>
    );
};

// Render only one graph entity's bounding-box crop from its PDF page.
// This is used by edge details; node clicks continue using the full-page viewer.
const PdfElementCrop = ({ url, entity }) => {
    const canvasRef = useRef(null);
    const [error, setError] = useState("");

    useEffect(() => {
        let cancelled = false;
        let renderTask;

        const renderCrop = async () => {
            setError("");
            const bbox = entity?.bbox_norm;
            if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) {
                setError("A crop is not available for this element.");
                return;
            }

            try {
                const task = pdfjsLib.getDocument({ url, httpHeaders: NGROK_HEADERS });
                const doc = await task.promise;
                if (cancelled) {
                    await task.destroy();
                    return;
                }

                const pageNumber = Math.max(1, Number(entity.page ?? entity.page_num) || 1);
                const page = await doc.getPage(pageNumber);
                const viewport = page.getViewport({ scale: 2 });
                const pageCanvas = document.createElement("canvas");
                pageCanvas.width = Math.ceil(viewport.width);
                pageCanvas.height = Math.ceil(viewport.height);

                renderTask = page.render({
                    canvasContext: pageCanvas.getContext("2d"),
                    viewport,
                });
                await renderTask.promise;
                if (cancelled || !canvasRef.current) {
                    await task.destroy();
                    return;
                }

                const [left, top, right, bottom] = bbox;
                const sx = Math.max(0, Math.floor(left * pageCanvas.width));
                const sy = Math.max(0, Math.floor(top * pageCanvas.height));
                const sw = Math.max(1, Math.min(pageCanvas.width - sx, Math.ceil((right - left) * pageCanvas.width)));
                const sh = Math.max(1, Math.min(pageCanvas.height - sy, Math.ceil((bottom - top) * pageCanvas.height)));

                const output = canvasRef.current;
                output.width = sw;
                output.height = sh;
                output.getContext("2d").drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
                await task.destroy();
            } catch (err) {
                if (!cancelled) {
                    console.error("Could not render entity crop:", err);
                    setError("Could not load this element's crop.");
                }
            }
        };

        renderCrop();
        return () => {
            cancelled = true;
            renderTask?.cancel();
        };
    }, [url, entity?.id, entity?.page, entity?.page_num, entity?.bbox_norm]);

    return (
        <div className="w-full h-48 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-center overflow-hidden">
            {error ? (
                <p className="px-4 text-xs text-zinc-500 text-center">{error}</p>
            ) : (
                <canvas ref={canvasRef} className="max-w-full max-h-full object-contain" />
            )}
        </div>
    );
};

const App = () => {
    const [file, setFile] = useState(null);
    const [isUploading, setIsUploading] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const [query, setQuery] = useState("");
    const [chat, setChat] = useState([]);
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState("Initializing RAG pipeline...");
    const [viewMode, setViewMode] = useState("chat");
    const [graphData, setGraphData] = useState({ nodes: [], links: [] });
    const [citedIds, setCitedIds] = useState(() => new Set());
    const [docId, setDocId] = useState(null);
    const [isRestoring, setIsRestoring] = useState(true);
    const chatHydrated = useRef(false); // don't overwrite saved chat before restore finishes

    // Human in loop states
    const [feedbackTarget, setFeedbackTarget] = useState(null);
    const [feedbackText, setFeedbackText] = useState("");
    const [feedbackSending, setFeedbackSending] = useState(false);
    const [feedbackMessage, setFeedbackMessage] = useState("");

    // --- PDF Modal States ---
    const [pdfUrl, setPdfUrl] = useState(null);
    const [isPdfModalOpen, setIsPdfModalOpen] = useState(false);
    const [activeCite, setActiveCite] = useState({ page: 1 });
    const [selectedEdge, setSelectedEdge] = useState(null);

    const scrollRef = useRef(null);

    useEffect(() => {
        if (viewMode === "chat") {
            scrollRef.current?.scrollIntoView({ behavior: "smooth" });
        }
    }, [chat, viewMode, loading, status]);

    useEffect(() => {
        return () => {
            if (pdfUrl && pdfUrl.startsWith("blob:")) URL.revokeObjectURL(pdfUrl);
        };
    }, [pdfUrl]);

    // ---- On load/refresh: fetch the saved knowledge graph from the backend ----
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`${API_BASE}/graph`, { headers: NGROK_HEADERS });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (cancelled) return;

                if (data.ready && data.graphData) {
                    setGraphData(data.graphData);
                    setFile({ name: data.filename });
                    setDocId(data.doc_id);
                    setPdfUrl(`${API_BASE}/pdf/${data.doc_id}`);
                    setIsReady(true);

                    // Restore chat only if it belongs to this same document.
                    const saved = loadSavedChat();
                    if (saved && saved.docId === data.doc_id && saved.chat?.length) {
                        setChat(saved.chat);
                    } else {
                        clearSavedChat();
                        setChat([WELCOME_MSG]);
                    }
                } else {
                    clearSavedChat(); // no graph on the server -> old chat is stale
                }
            } catch (err) {
                console.warn("Could not restore session", err);
            } finally {
                if (!cancelled) {
                    chatHydrated.current = true;
                    setIsRestoring(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // ---- Persist chat to localStorage ----
    useEffect(() => {
        if (!chatHydrated.current || !docId || chat.length === 0) return;
        saveChat(docId, chat);
    }, [chat, docId]);

    // ---- Reset everything: chat, graph, stored PDF ----
    const handleReset = async () => {
        if (!window.confirm("Delete the chat, the knowledge graph and the stored PDF? This cannot be undone.")) return;
        try {
            await fetch(`${API_BASE}/reset`, { method: "POST", headers: NGROK_HEADERS });
        } catch (err) {
            console.error("Reset request failed", err);
        }
        clearSavedChat();
        setFile(null);
        setIsReady(false);
        setDocId(null);
        setPdfUrl(null);
        setIsPdfModalOpen(false);
        setActiveCite({ page: 1 });
        setGraphData({ nodes: [], links: [] });
        setCitedIds(new Set());
        setChat([]);
        setQuery("");
        setViewMode("chat");
        setStatus("Initializing RAG pipeline...");
    };

    const handleUpload = async (e) => {
        const selectedFile = e.target.files[0];
        if (!selectedFile) return;

        setIsUploading(true);
        const formData = new FormData();
        formData.append("file", selectedFile);

        try {
            const res = await fetch(`${API_BASE}/upload`, { method: "POST", body: formData, headers: NGROK_HEADERS });
            const data = await res.json();
            if (res.ok) {
                setFile(selectedFile);
                setIsReady(true);
                setGraphData(data.graphData);
                setDocId(data.doc_id);
                setPdfUrl(URL.createObjectURL(selectedFile));

                // Same PDF uploaded again -> keep its saved chat.
                const saved = data.cached ? loadSavedChat() : null;
                if (saved && saved.docId === data.doc_id && saved.chat?.length) {
                    setChat(saved.chat);
                } else {
                    setChat([WELCOME_MSG]);
                }
            }
        } catch (err) {
            console.error("Upload failed", err);
        } finally {
            setIsUploading(false);
        }
    };

    const handleFeedbackSubmit = async () => {
        if (!feedbackTarget || !feedbackText.trim() || feedbackSending) {
            return;
        }

        if (!docId) {
            setFeedbackMessage("No active document found.");
            return;
        }

        setFeedbackSending(true);
        setFeedbackMessage("");

        try {
            const msg = feedbackTarget.message;

            const res = await fetch(`${API_BASE}/feedback`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...NGROK_HEADERS,
                },
                body: JSON.stringify({
                    doc_id: docId,
                    question: msg.question || "",
                    answer: msg.content,
                    correction: feedbackText.trim(),
                    source_ids: (msg.sources || []).map((s) => (typeof s === "object" ? s.id : null)).filter(Boolean),
                    rating: "correction",
                }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.detail || "Failed to submit correction.");
            }

            // The backend must return the UPDATED graph after
            // modifying and persisting its nodes and links.
            let updatedGraph = data.graphData;

            // Fallback: fetch the graph again if it wasn't returned.
            if (!updatedGraph) {
                const graphRes = await fetch(`${API_BASE}/graph`, {
                    headers: NGROK_HEADERS,
                });

                if (!graphRes.ok) {
                    throw new Error("Correction was received, but graph refresh failed.");
                }

                const graphResponse = await graphRes.json();
                updatedGraph = graphResponse.graphData;
            }

            if (!updatedGraph || !Array.isArray(updatedGraph.nodes) || !Array.isArray(updatedGraph.links)) {
                throw new Error("Backend did not return a valid updated graph.");
            }

            // Refresh the visible graph with the backend's graph.
            setGraphData({
                nodes: updatedGraph.nodes,
                links: updatedGraph.links,
            });

            setFeedbackMessage(data.message || "Correction applied and graph refreshed.");

            setFeedbackTarget(null);
            setFeedbackText("");
        } catch (err) {
            console.error("Correction submission failed:", err);
            setFeedbackMessage(err.message || "Could not submit correction.");
        } finally {
            setFeedbackSending(false);
        }
    };

    const handleQuery = async (e) => {
        e.preventDefault();
        if (!query.trim() || loading) return;

        const userMsg = query;
        setQuery("");
        setChat((prev) => [...prev, { role: "user", content: userMsg }]);
        setLoading(true);
        setStatus("Sending query to VLM...");

        try {
            const res = await fetch(`${API_BASE}/query`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...NGROK_HEADERS },
                body: JSON.stringify({ query: userMsg }),
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let done = false;
            let buffer = "";

            while (!done) {
                const { value, done: readerDone } = await reader.read();
                done = readerDone;

                if (value) {
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop(); // keep the incomplete last line for the next chunk

                    for (const line of lines.filter((l) => l.trim() !== "")) {
                        try {
                            const data = JSON.parse(line);

                            if (data.status) setStatus(data.status);

                            if (data.error) {
                                setChat((prev) => [...prev, { role: "bot", content: `Error: ${data.error}` }]);
                            }

                            if (data.answer) {
                                setChat((prev) => [
                                    ...prev,
                                    {
                                        role: "bot",
                                        content: data.answer,
                                        sources: data.sources,
                                        question: userMsg,
                                    },
                                ]);
                                setCitedIds(
                                    new Set(
                                        (data.sources || [])
                                            .map((s) => (typeof s === "object" ? s.id : null))
                                            .filter(Boolean),
                                    ),
                                );
                            }
                        } catch (err) {
                            console.error("Failed to parse stream chunk:", err, line);
                        }
                    }
                }
            }
        } catch (err) {
            setChat((prev) => [...prev, { role: "bot", content: "Error connecting to backend." }]);
        } finally {
            setLoading(false);
        }
    };

    const getEdgeColor = useCallback((link) => {
        switch (link.type || link.edge_type) {
            case "sequential":
            case "next_element":
                return "rgba(161, 161, 170, 0.3)";
            case "visual_similar":
                return "#ef4444";
            case "text_similar":
                return "#10b981";
            case "user_correction":
                return "#a855f7";
            default:
                return "#ffffff";
        }
    }, []);

    const getLinkWidth = useCallback((link) => {
        const t = link.type || link.edge_type;

        if (t === "user_correction") return 3;

        return t === "sequential" || t === "next_element" ? 0.5 : 1.5;
    }, []);

    const openCitation = (item) => {
        setActiveCite(typeof item === "number" ? { page: item } : toCite(item));
        setIsPdfModalOpen(true);
    };

    const getEdgeDetails = (link) => {
        const edgeType = link?.type || link?.edge_type || "unknown";
        const weight = Number(link?.weight);
        const hasWeight = Number.isFinite(weight);
        const sourceId = typeof link?.source === "object" ? link.source.id : link?.source;
        const targetId = typeof link?.target === "object" ? link.target.id : link?.target;
        const source = graphData.nodes.find((node) => String(node.id) === String(sourceId));
        const target = graphData.nodes.find((node) => String(node.id) === String(targetId));

        const explanations = {
            next_element: {
                title: "Sequential relationship",
                description:
                    "These elements are connected because they are consecutive in the document's reading order. The edge preserves the document's structure and flow; it does not necessarily mean the contents are semantically similar.",
                reason: "The graph builder connects each element to the next element after sorting by page number and reading order.",
                color: "#a1a1aa",
            },
            sequential: {
                title: "Sequential relationship",
                description:
                    "These elements are connected because they are consecutive in the document's reading order.",
                reason: "The edge represents document order rather than semantic similarity.",
                color: "#a1a1aa",
            },
            text_similar: {
                title: "Text similarity",
                description:
                    "The text associated with these two elements is semantically similar according to the text embedding model.",
                reason: "The graph builder adds this edge when the cosine similarity between the two text embeddings reaches the configured threshold (0.78 by default).",
                color: "#10b981",
            },
            visual_similar: {
                title: "Visual similarity",
                description:
                    "The visual content of these two elements is similar according to the image embedding model.",
                reason: "The graph builder adds this edge when the cosine similarity between the two visual embeddings reaches the configured threshold (0.85 by default).",
                color: "#ef4444",
            },
            user_correction: {
                title: "User correction relationship",
                description:
                    "A correction node is linked to the source element or elements that the user selected when submitting the correction.",
                reason: "This edge was explicitly created by the feedback workflow to preserve the correction's connection to its cited source.",
                color: "#a855f7",
            },
        };

        const details = explanations[edgeType] || {
            title: String(edgeType).replaceAll("_", " "),
            description: "These two elements are connected by this relationship type in the knowledge graph.",
            reason: "The backend did not provide a more specific explanation for this edge type.",
            color: "#ffffff",
        };

        return {
            ...details,
            edgeType,
            source,
            target,
            weight: hasWeight ? weight : null,
        };
    };

    const handleLinkClick = useCallback(
        (link) => {
            const details = getEdgeDetails(link);
            if (!details.source || !details.target) {
                console.warn("Could not resolve both entities for graph edge:", link);
                return;
            }
            setSelectedEdge(details);
        },
        [graphData.nodes],
    );

    // ---------- 3D graph accessors (memoised so the graph doesn't rebuild on unrelated renders) ----------
    const nodeThreeObject = useCallback(
        (node) => {
            const group = new THREE.Group();
            const material =
                node.element_type === "correction" ? MAT_CORRECTION : citedIds.has(node.id) ? MAT_CITED : MAT_DEFAULT;

            group.add(new THREE.Mesh(SPHERE_GEO, material));

            const sprite = new SpriteText(`${typeLabel(node)} · p.${pageOf(node)}`);
            sprite.color = "#ffffff";
            sprite.textHeight = 3.5;
            sprite.position.set(0, 10, 0);
            group.add(sprite);
            return group;
        },
        [citedIds],
    );

    const nodeLabel = useCallback((node) => {
        const full = node.text || "";
        const text = full.slice(0, 500);
        return `
        <div style="max-width:320px;padding:10px 12px;background:#18181b;border:1px solid #3f3f46;border-radius:8px;font-size:12px;line-height:1.45;color:#e4e4e7">
            <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin-bottom:8px">
                <span style="color:#71717a">Type</span>
                <span style="font-weight:600;color:#fbbf24;text-transform:capitalize">${escapeHtml(typeLabel(node))}</span>
                <span style="color:#71717a">Page</span>
                <span>${escapeHtml(pageOf(node))}</span>
                <span style="color:#71717a">ID</span>
                <span style="font-family:monospace;color:#60a5fa">${escapeHtml(node.id ?? node.name)}</span>
            </div>
            ${
                full
                    ? `<div style="color:#a1a1aa;border-top:1px solid #3f3f46;padding-top:6px">${isTableEntity(node) ? tableHtml(full) : `<div style="white-space:pre-wrap">${escapeHtml(text)}${full.length > 500 ? "…" : ""}</div>`}</div>`
                    : `<div style="color:#71717a;border-top:1px solid #3f3f46;padding-top:6px">(no text content)</div>`
            }
            <div style="color:#71717a;margin-top:6px;font-size:10px">Click to open in PDF</div>
        </div>`;
    }, []);

    const handleNodeClick = useCallback((node) => openCitation(node), []);

    return (
        <div className="min-h-screen bg-[#09090b] text-zinc-100 font-sans selection:bg-blue-500/30 flex flex-col">
            {/* Edge relationship explanation modal */}
            {selectedEdge && (
                <div
                    className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 md:p-8"
                    onClick={() => setSelectedEdge(null)}
                >
                    <div
                        className="w-full max-w-5xl max-h-[92vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
                            <div>
                                <p className="text-xs uppercase tracking-wider text-zinc-500">
                                    Knowledge graph relationship
                                </p>
                                <h2 className="mt-1 text-lg font-semibold text-white capitalize">
                                    {selectedEdge.title}
                                </h2>
                            </div>
                            <button
                                onClick={() => setSelectedEdge(null)}
                                aria-label="Close edge explanation"
                                className="p-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        <div className="p-5 space-y-5">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {[selectedEdge.source, selectedEdge.target].map((entity, index) => (
                                    <div
                                        key={entity.id}
                                        className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 min-w-0"
                                    >
                                        <div className="flex items-center justify-between gap-2 mb-3">
                                            <div className="min-w-0">
                                                <p className="text-xs text-zinc-500">
                                                    {index === 0 ? "ENTITY A" : "ENTITY B"}
                                                </p>
                                                <h3 className="font-semibold text-zinc-100 capitalize truncate">
                                                    {typeLabel(entity)}
                                                </h3>
                                            </div>
                                            <span className="text-xs text-zinc-500 shrink-0">
                                                Page {pageOf(entity)}
                                            </span>
                                        </div>
                                        <PdfElementCrop url={pdfUrl} entity={entity} />
                                        <EntityTextContent entity={entity} />
                                        <p className="mt-2 text-[10px] font-mono text-zinc-600">{entity.id}</p>
                                    </div>
                                ))}
                            </div>

                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                                <div className="flex items-center gap-2 mb-3">
                                    <span
                                        className="w-3 h-3 rounded-full"
                                        style={{ backgroundColor: selectedEdge.color }}
                                    />
                                    <h3 className="text-sm font-semibold text-white">
                                        Why are these entities connected?
                                    </h3>
                                </div>
                                <p className="text-sm text-zinc-300 leading-relaxed">{selectedEdge.description}</p>
                                <div className="mt-3 p-3 rounded-lg bg-zinc-900 border border-zinc-800">
                                    <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                                        Connection rule
                                    </p>
                                    <p className="text-sm text-zinc-300 leading-relaxed">{selectedEdge.reason}</p>
                                </div>
                                <div className="flex flex-wrap items-center gap-3 mt-4 text-xs">
                                    <span className="px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-300">
                                        Type: {selectedEdge.edgeType}
                                    </span>
                                    {selectedEdge.weight !== null && (
                                        <span className="px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-300">
                                            {["text_similar", "visual_similar"].includes(selectedEdge.edgeType)
                                                ? `Cosine similarity: ${selectedEdge.weight.toFixed(4)}`
                                                : `Edge weight: ${selectedEdge.weight.toFixed(4)}`}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* PDF Viewer Modal */}
            {isPdfModalOpen && pdfUrl && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 md:p-8 animate-in fade-in duration-200">
                    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-6xl h-full flex flex-col overflow-hidden relative">
                        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-md">
                            <div className="flex items-center gap-2 text-zinc-300 font-medium text-sm">
                                <FileText size={16} className="text-blue-400" />
                                {file?.name}
                            </div>
                            <button
                                onClick={() => setIsPdfModalOpen(false)}
                                className="p-1.5 bg-zinc-800 text-zinc-400 rounded-lg hover:bg-zinc-700 hover:text-white transition-colors"
                            >
                                <X size={18} />
                            </button>
                        </div>
                        <div className="flex-1 w-full bg-zinc-950 min-h-0">
                            <PdfPageView url={pdfUrl} cite={activeCite} />
                        </div>
                    </div>
                </div>
            )}

            <header className="border-b border-zinc-800 bg-[#09090b]/80 backdrop-blur-md sticky top-0 z-50">
                <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                        <div className="bg-blue-600 p-1.5 rounded-lg">
                            <Zap size={20} className="fill-white" />
                        </div>
                        <h1 className="text-lg font-semibold tracking-tight">
                            MIRAS <span className="text-zinc-500 font-normal text-sm ml-1">VLM</span>
                        </h1>
                    </div>

                    {isReady && (
                        <div className="flex bg-zinc-900 border border-zinc-800 p-1 rounded-full">
                            <button
                                onClick={() => setViewMode("chat")}
                                className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                                    viewMode === "chat" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200"
                                }`}
                            >
                                <MessageSquare size={14} /> Chat
                            </button>
                            <button
                                onClick={() => setViewMode("graph")}
                                className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                                    viewMode === "graph"
                                        ? "bg-zinc-800 text-white"
                                        : "text-zinc-400 hover:text-zinc-200"
                                }`}
                            >
                                <Network size={14} /> 3D Graph
                            </button>
                        </div>
                    )}

                    {isRestoring ? (
                        <div className="flex items-center gap-2 text-zinc-400 text-sm">
                            <Loader2 size={14} className="animate-spin" />
                            Restoring session...
                        </div>
                    ) : !isReady ? (
                        <label className="cursor-pointer bg-zinc-100 text-zinc-900 px-4 py-1.5 rounded-full text-sm font-medium hover:bg-zinc-200 transition-colors flex items-center gap-2">
                            <Upload size={14} />
                            {isUploading ? "Processing..." : "Upload PDF"}
                            <input type="file" className="hidden" onChange={handleUpload} accept=".pdf" />
                        </label>
                    ) : (
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => openCitation(1)}
                                className="flex items-center gap-2 text-emerald-400 text-sm font-medium bg-emerald-400/10 px-3 py-1 rounded-full border border-emerald-400/20 hover:bg-emerald-400/20 transition-colors cursor-pointer"
                            >
                                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                {file?.name}
                            </button>
                            <button
                                onClick={handleReset}
                                title="Reset everything (chat, graph, PDF)"
                                aria-label="Reset everything"
                                className="p-1.5 rounded-full text-zinc-400 border border-zinc-800 bg-zinc-900 hover:text-red-400 hover:border-red-400/40 hover:bg-red-400/10 transition-colors cursor-pointer"
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                    )}
                </div>
            </header>

            {viewMode === "chat" ? (
                <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-8 pb-32">
                    <div className="space-y-8">
                        {chat.length === 0 && (
                            <div className="py-20 text-center">
                                <div className="bg-zinc-900 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6 border border-zinc-800">
                                    <FileText className="text-zinc-400" size={32} />
                                </div>
                                <h2 className="text-2xl font-medium mb-2">Upload a document to start</h2>
                                <p className="text-zinc-500 max-w-sm mx-auto">
                                    Our VLM-powered Graph-RAG will analyze the visuals and text to provide precise
                                    answers.
                                </p>
                            </div>
                        )}

                        {chat.map((msg, i) => (
                            <div
                                key={i}
                                className={`flex w-full ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                            >
                                {msg.role === "user" ? (
                                    <div className="bg-zinc-800 text-zinc-100 px-5 py-3 rounded-2xl rounded-tr-sm max-w-[75%] shadow-sm">
                                        <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                                    </div>
                                ) : (
                                    <div className="flex gap-4 w-full">
                                        <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 border bg-blue-600/10 border-blue-500/30 text-blue-400 mt-0.5">
                                            <Bot size={16} />
                                        </div>
                                        <div className="flex-1 space-y-4 min-w-0 pt-1">
                                            <div className="text-zinc-300 leading-relaxed text-sm">
                                                <ReactMarkdown
                                                    remarkPlugins={[remarkGfm]}
                                                    components={{
                                                        table: ({ node, ...props }) => (
                                                            <div className="overflow-x-auto my-6 shadow-lg rounded-md">
                                                                <table
                                                                    className="w-full border-collapse border-2 border-zinc-200 text-sm"
                                                                    {...props}
                                                                />
                                                            </div>
                                                        ),
                                                        th: ({ node, ...props }) => (
                                                            <th
                                                                className="border-2 border-zinc-200 bg-zinc-800 px-4 py-3 font-semibold text-white text-left tracking-wide"
                                                                {...props}
                                                            />
                                                        ),
                                                        td: ({ node, ...props }) => (
                                                            <td
                                                                className="border border-zinc-200/80 px-4 py-2 text-zinc-100"
                                                                {...props}
                                                            />
                                                        ),
                                                        p: ({ node, ...props }) => (
                                                            <p className="mb-4 last:mb-0" {...props} />
                                                        ),
                                                        ul: ({ node, ...props }) => (
                                                            <ul className="list-disc pl-5 mb-4 space-y-1" {...props} />
                                                        ),
                                                        ol: ({ node, ...props }) => (
                                                            <ol
                                                                className="list-decimal pl-5 mb-4 space-y-1"
                                                                {...props}
                                                            />
                                                        ),
                                                    }}
                                                >
                                                    {msg.content}
                                                </ReactMarkdown>
                                            </div>
                                            {msg.sources && msg.sources.length > 0 && (
                                                <div className="flex gap-2 flex-wrap mt-3">
                                                    {msg.sources.map((s, idx) => {
                                                        const isObj = typeof s === "object";
                                                        const label = isObj
                                                            ? `${s.element_type || s.type || "element"} · p.${s.page ?? s.page_num ?? "?"}`
                                                            : `Page ${s}`;
                                                        return (
                                                            <button
                                                                key={isObj ? s.id : `${s}-${idx}`}
                                                                onClick={() => openCitation(s)}
                                                                title={
                                                                    isObj && s.text ? s.text.slice(0, 200) : undefined
                                                                }
                                                                className="text-[10px] font-bold px-2.5 py-1 bg-zinc-800 text-zinc-300 hover:text-white hover:bg-blue-600 hover:border-blue-500 rounded uppercase tracking-wider border border-zinc-700 transition-all cursor-pointer shadow-sm"
                                                            >
                                                                {label}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            )}

                                            <div className="flex justify-end gap-3 mt-4">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setFeedbackTarget({ message: msg });
                                                        setFeedbackText("");
                                                        setFeedbackMessage("");
                                                    }}
                                                    className="text-xs px-3 py-2 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                                                >
                                                    Suggest a correction
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                        {/* change suggestion pop up */}
                        {feedbackTarget && (
                            <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                                <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
                                    <h3 className="text-lg font-semibold text-white">Suggest a correction</h3>

                                    <p className="mt-2 text-sm text-zinc-400">
                                        Tell us what is incorrect and provide the corrected information.
                                    </p>

                                    <textarea
                                        value={feedbackText}
                                        onChange={(e) => setFeedbackText(e.target.value)}
                                        placeholder="Enter your correction..."
                                        rows={5}
                                        maxLength={5000}
                                        disabled={feedbackSending}
                                        className="mt-4 w-full resize-y rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-sm text-zinc-200 placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                                    />

                                    {feedbackMessage && <p className="mt-3 text-sm text-zinc-300">{feedbackMessage}</p>}

                                    <div className="mt-4 flex justify-end gap-3">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setFeedbackTarget(null);
                                                setFeedbackText("");
                                                setFeedbackMessage("");
                                            }}
                                            disabled={feedbackSending}
                                            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                                        >
                                            Cancel
                                        </button>

                                        <button
                                            type="button"
                                            onClick={handleFeedbackSubmit}
                                            disabled={feedbackSending || feedbackText.trim().length < 5}
                                            className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
                                        >
                                            {feedbackSending ? "Sending..." : "Submit correction"}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {loading && (
                            <div className="flex w-full justify-start">
                                <div className="flex gap-4 w-full">
                                    <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 border bg-blue-600/10 border-blue-500/30 text-blue-400 mt-0.5">
                                        <Bot size={16} />
                                    </div>
                                    <div className="flex-1 pt-1.5 flex items-center gap-3 text-zinc-400 text-sm italic">
                                        <Loader2 size={16} className="animate-spin text-blue-500" />
                                        {status}
                                    </div>
                                </div>
                            </div>
                        )}
                        <div ref={scrollRef} />
                    </div>
                </main>
            ) : (
                <div className="flex-1 relative w-full h-[calc(100vh-64px)] overflow-hidden cursor-move bg-[#040405]">
                    <div className="absolute top-6 left-6 z-10 bg-zinc-900/80 backdrop-blur-md border border-zinc-800 p-4 rounded-xl shadow-2xl pointer-events-none">
                        <h3 className="text-sm font-semibold mb-3 tracking-tight">Graph Legend</h3>
                        <div className="space-y-2 text-xs text-zinc-300">
                            <div className="flex items-center gap-2">
                                <div className="w-4 h-1 bg-blue-500 rounded-full" />
                                <span>Document Element</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-4 h-1 bg-amber-500 rounded-full" />
                                <span>Cited in last answer</span>
                            </div>
                            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-zinc-800">
                                <div className="w-4 h-0.5 bg-zinc-400 opacity-60" />
                                <span>Sequential (next element)</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-4 h-0.5 bg-red-500" />
                                <span>Visual Similarity (CLIP)</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-4 h-0.5 bg-emerald-500" />
                                <span>Text Similarity (BGE)</span>
                            </div>
                        </div>
                        <p className="text-[10px] text-zinc-500 mt-4 pt-3 border-t border-zinc-800">
                            Drag to rotate • Scroll to zoom • Click nodes to open PDF • Click edges for relationship
                            details
                        </p>
                    </div>

                    <ForceGraph3D
                        graphData={graphData}
                        backgroundColor="#040405"
                        nodeLabel={nodeLabel}
                        onNodeClick={handleNodeClick}
                        onLinkClick={handleLinkClick}
                        nodeThreeObject={nodeThreeObject}
                        linkColor={getEdgeColor}
                        linkWidth={getLinkWidth}
                    />
                </div>
            )}

            {viewMode === "chat" && (
                <div className="fixed bottom-0 left-0 right-0 bg-gradient-to-t from-[#09090b] via-[#09090b] to-transparent pt-10 pb-8 px-6">
                    <form onSubmit={handleQuery} className="max-w-4xl mx-auto relative group">
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            disabled={!isReady || loading}
                            placeholder={isReady ? "Ask anything about the document..." : "Please upload a PDF first"}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded-2xl py-4 pl-6 pr-14 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 transition-all shadow-2xl disabled:opacity-50"
                        />
                        <button
                            type="submit"
                            disabled={!query.trim() || loading}
                            className="absolute right-3 top-1/2 -translate-y-1/2 p-2 bg-blue-600 text-white rounded-xl hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 transition-colors shadow-lg"
                        >
                            <Send size={18} />
                        </button>
                    </form>
                </div>
            )}
        </div>
    );
};

export default App;
