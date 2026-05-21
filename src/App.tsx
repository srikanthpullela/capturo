import React, { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import "./App.css";

// ── Types ──────────────────────────────────────────────────────────────────
type AppMode = "idle" | "capturing";
type AppTab = "editor" | "history" | "preferences";
type SaveFormat = "png" | "jpg";
type AnnToolId = "box" | "circle" | "arrow" | "highlight" | "pen" | "text" | "eraser";
type AnnTool = AnnToolId | null;

interface AnnPoint { x: number; y: number; }
interface Annotation {
  id: string;
  tool: AnnToolId;
  x1: number; y1: number; x2: number; y2: number;
  color: string;
  lineWidth: number;
  points?: AnnPoint[];
  text?: string;
  fontSize?: number;
}

interface BG { id: string; label: string; css: string; }

interface Preferences {
  closeAfterCopy: boolean;
  saveHistory: boolean;
  hideWindowOnCapture: boolean;
  hideAtLaunch: boolean;
  includeWatermark: boolean;
  watermarkPadding: number;
  soundEffects: boolean;
  saveFormat: SaveFormat;
  defaultFileName: string;
}

interface HistoryItem {
  id: string;
  timestamp: number;
  croppedShot: string;
  bg: BG;
  padding: number;
  radius: number;
  shadow: number;
  blur: number;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const isToday = d.toDateString() === new Date().toDateString();
  return isToday
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const BACKGROUNDS: BG[] = [
  { id: "violet",   label: "Violet",   css: "linear-gradient(135deg,#6366f1,#8b5cf6)" },
  { id: "ocean",    label: "Ocean",    css: "linear-gradient(135deg,#0ea5e9,#6366f1)" },
  { id: "rose",     label: "Rose",     css: "linear-gradient(135deg,#f43f5e,#ec4899)" },
  { id: "amber",    label: "Amber",    css: "linear-gradient(135deg,#f59e0b,#ef4444)" },
  { id: "emerald",  label: "Emerald",  css: "linear-gradient(135deg,#10b981,#06b6d4)" },
  { id: "midnight", label: "Midnight", css: "linear-gradient(135deg,#1e1b4b,#312e81,#4c1d95)" },
  { id: "aurora",   label: "Aurora",   css: "linear-gradient(135deg,#7c3aed,#2563eb,#0891b2)" },
  { id: "peach",    label: "Peach",    css: "linear-gradient(135deg,#fb923c,#f9a8d4)" },
  { id: "forest",   label: "Forest",   css: "linear-gradient(135deg,#14532d,#166534)" },
  { id: "candy",    label: "Candy",    css: "linear-gradient(135deg,#a855f7,#ec4899,#f43f5e)" },
  { id: "dark",     label: "Dark",     css: "#0a0a0b" },
  { id: "none",     label: "None",     css: "transparent" },
];

const ANN_COLORS = ["#f43f5e", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ffffff"];
const SHORTCUT_LABEL = "Ctrl/Cmd⇧9";
const SHORTCUT_ACCELERATOR = "CommandOrControl+Shift+9";
const DEFAULT_PREFS: Preferences = {
  closeAfterCopy: true,
  saveHistory: true,
  hideWindowOnCapture: true,
  hideAtLaunch: false,
  includeWatermark: true,
  watermarkPadding: 32,
  soundEffects: true,
  saveFormat: "png",
  defaultFileName: "Capturo-{datetime}",
};

function parseGradStops(css: string): string[] {
  return css.match(/#[0-9a-fA-F]{6}/g) ?? ["#6366f1", "#8b5cf6"];
}

function CapturoLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="capturoLogoBg" x1="3" y1="2" x2="25" y2="26" gradientUnits="userSpaceOnUse">
          <stop stopColor="#06b6d4"/>
          <stop offset="0.48" stopColor="#6366f1"/>
          <stop offset="1" stopColor="#a855f7"/>
        </linearGradient>
        <linearGradient id="capturoLogoMark" x1="7" y1="6" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff"/>
          <stop offset="1" stopColor="#dbeafe"/>
        </linearGradient>
      </defs>
      <rect width="28" height="28" rx="8" fill="url(#capturoLogoBg)"/>
      <path d="M19.2 8.5a7 7 0 1 0 0 11" stroke="url(#capturoLogoMark)" strokeWidth="3.2" strokeLinecap="round"/>
      <circle cx="20.4" cy="14" r="2.35" stroke="#ffffff" strokeOpacity="0.82" strokeWidth="1.05"/>
      <path d="M18.2 14h4.4M20.4 11.8v4.4" stroke="#ffffff" strokeOpacity="0.96" strokeWidth="1.05" strokeLinecap="round"/>
      <circle cx="20.4" cy="14" r="0.68" fill="#ffffff" fillOpacity="0.98"/>
    </svg>
  );
}

function drawWatermark(ctx: CanvasRenderingContext2D, cw: number, ch: number, padding: number) {
  const shortSide = Math.max(1, Math.min(cw, ch));
  const fontSize = Math.max(12, Math.min(18, Math.round(shortSide * 0.017)));
  const margin = Math.max(18, padding);
  const label = "Screenshot by Capturo";

  ctx.save();
  ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = Math.max(3, fontSize * 0.35);
  ctx.shadowOffsetY = Math.max(1, fontSize * 0.08);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText(label, cw - margin, ch - margin);
  ctx.restore();
}

function loadPrefs(): Preferences {
  try {
    const saved = localStorage.getItem("capturo_preferences");
    return saved ? { ...DEFAULT_PREFS, ...JSON.parse(saved) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

function makeFileName(template: string, ext: SaveFormat) {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const datetime = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const base = (template || DEFAULT_PREFS.defaultFileName)
    .replace(/\{datetime\}/g, datetime)
    .replace(/\{date\}/g, `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`)
    .replace(/\{time\}/g, `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`)
    .replace(/[^a-z0-9._ -]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "") || DEFAULT_PREFS.defaultFileName.replace("{datetime}", datetime);
  return `${base}.${ext}`;
}

function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, lw: number) {
  const headLen = Math.max(14, lw * 4);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath(); ctx.fill();
}

// Hit-test: returns true if (x,y) falls within an annotation's bounding area
function hitAnnotation(ann: Annotation, x: number, y: number): boolean {
  const M = 12;
  if (ann.tool === "pen" && ann.points) {
    return ann.points.some(p => Math.hypot(p.x - x, p.y - y) < 15);
  }
  const minX = Math.min(ann.x1, ann.x2) - M;
  const maxX = Math.max(ann.x1, ann.x2) + M;
  const minY = Math.min(ann.y1, ann.y2) - M;
  const maxY = Math.max(ann.y1, ann.y2) + M;
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

// Pen cursor: SVG pencil with hotspot at the tip
const PEN_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'%3E%3Cpath d='M3 16.5l2.5-.8L17 5 15 3 3.5 14 3 16.5z' fill='white' stroke='%23333' stroke-width='1.2' stroke-linejoin='round'/%3E%3Cpath d='M15 3l2 2' stroke='%23333' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E") 2 18, crosshair`;
const ERASER_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'%3E%3Crect x='2' y='10' width='18' height='10' rx='2' fill='%23fff' stroke='%23555' stroke-width='1.4'/%3E%3Cpath d='M2 15h18' stroke='%23ccc' stroke-width='1'/%3E%3C/svg%3E") 9 15, crosshair`;

// ── Main Component ─────────────────────────────────────────────────────────
export default function App() {
  const [mode, setMode]               = useState<AppMode>("idle");
  const [croppedShot, setCroppedShot] = useState<string | null>(null);

  const [bg, setBg]           = useState<BG>(BACKGROUNDS.find(b => b.id === 'candy') ?? BACKGROUNDS[0]);
  const [padding, setPadding] = useState(48);
  const [radius, setRadius]   = useState(12);
  const [shadow, setShadow]   = useState(60);
  const [blur, setBlur]       = useState(0);

  const [annTool, setAnnTool]           = useState<AnnTool>(null);
  const [annColor, setAnnColor]         = useState(ANN_COLORS[0]);
  const [annLineWidth, setAnnLineWidth] = useState(3);
  const [annotations, setAnnotations]   = useState<Annotation[]>([]);
  const [annDraft, setAnnDraft]         = useState<Annotation | null>(null);
  const [textInput, setTextInput]       = useState<AnnPoint | null>(null);
  const [textInputValue, setTextInputValue] = useState("");

  const [activeTab, setActiveTab] = useState<AppTab>("editor");
  const [preferences, setPreferences] = useState<Preferences>(() => loadPrefs());
  const [history, setHistory]     = useState<HistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem("capturo_history");
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [toast, setToast] = useState("");

  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const annCanvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef       = useRef<HTMLImageElement | null>(null);
    const annDragging   = useRef(false);
    const annStart      = useRef<AnnPoint>({ x: 0, y: 0 });
    const annDragId     = useRef<string | null>(null);
    const annDragOffset = useRef<AnnPoint>({ x: 0, y: 0 });
    const penPoints     = useRef<AnnPoint[]>([]);
  const toastTimer         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureInProgress  = useRef(false);
  const compositeRef = useRef<() => void>(() => {});


  // ── Toast ────────────────────────────────────────────────────────────────
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2400);
  };

  const updatePref = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setPreferences(prev => ({ ...prev, [key]: value }));
  };

  const playDoneSound = useCallback(() => {
    if (!preferences.soundEffects) return;
    try {
      const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;
      const audio = new AudioContextCtor();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = 720;
      gain.gain.setValueAtTime(0.001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.045, audio.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
      osc.connect(gain); gain.connect(audio.destination);
      osc.start(); osc.stop(audio.currentTime + 0.13);
      setTimeout(() => audio.close().catch(() => {}), 220);
    } catch {}
  }, [preferences.soundEffects]);

  // ── Canvas compositing ───────────────────────────────────────────────────
  const composite = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const cw = iw + padding * 2, ch = ih + padding * 2;
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext("2d")!;

    if (bg.css === "transparent") {
      ctx.clearRect(0, 0, cw, ch);
    } else if (bg.css.startsWith("linear-gradient")) {
      const stops = parseGradStops(bg.css);
      const grad = ctx.createLinearGradient(0, 0, cw, ch);
      stops.forEach((c, i) => grad.addColorStop(i / (stops.length - 1), c));
      ctx.fillStyle = grad; ctx.fillRect(0, 0, cw, ch);
    } else {
      ctx.fillStyle = bg.css; ctx.fillRect(0, 0, cw, ch);
    }

    ctx.save();
    if (shadow > 0) {
      ctx.shadowColor = "rgba(0,0,0,0.55)";
      ctx.shadowBlur  = shadow * 1.5;
      ctx.shadowOffsetY = shadow * 0.4;
    }
    const r = radius, x = padding, y = padding, w = iw, h = ih;
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
    ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
    ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
    ctx.closePath(); ctx.clip();
    if (blur > 0) ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(img, x, y, w, h);
    if (blur > 0) ctx.filter = "none";
    ctx.restore();
    if (preferences.includeWatermark) drawWatermark(ctx, cw, ch, preferences.watermarkPadding);
    }, [bg, padding, radius, shadow, blur, preferences.includeWatermark, preferences.watermarkPadding]);

  useEffect(() => {
    if (!croppedShot) return;
    const img = new Image();
    img.onload = () => { imgRef.current = img; composite(); };
    img.src = `data:image/png;base64,${croppedShot}`;
  }, [croppedShot, composite]);

  // Keep compositeRef pointing at the latest composite so we can call it from stable callbacks
  useEffect(() => { compositeRef.current = composite; }, [composite]);

  // Repaint when switching to editor tab — canvas may have been unmounted while on history tab
  useEffect(() => {
    if (activeTab === "editor" && croppedShot && canvasRef.current && imgRef.current) {
      compositeRef.current();
    }
  }, [activeTab, croppedShot]);

  // ── Annotation canvas ────────────────────────────────────────────────────
  const drawAnnotation = useCallback((ctx: CanvasRenderingContext2D, a: Annotation) => {
    ctx.strokeStyle = a.color; ctx.fillStyle = a.color;
    ctx.lineWidth = a.lineWidth; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (a.tool === "box") {
      ctx.strokeRect(a.x1, a.y1, a.x2 - a.x1, a.y2 - a.y1);
    } else if (a.tool === "circle") {
      const cx = (a.x1 + a.x2) / 2, cy = (a.y1 + a.y2) / 2;
      const rx = Math.max(Math.abs(a.x2 - a.x1) / 2, 1);
      const ry = Math.max(Math.abs(a.y2 - a.y1) / 2, 1);
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (a.tool === "arrow") {
      drawArrow(ctx, a.x1, a.y1, a.x2, a.y2, a.lineWidth);
    } else if (a.tool === "highlight") {
      ctx.globalAlpha = 0.38;
      ctx.fillRect(a.x1, a.y1, a.x2 - a.x1, a.y2 - a.y1);
      ctx.globalAlpha = 1;
    } else if (a.tool === "pen" && a.points && a.points.length > 1) {
      ctx.beginPath(); ctx.moveTo(a.points[0].x, a.points[0].y);
      for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x, a.points[i].y);
      ctx.stroke();
    } else if (a.tool === "text" && a.text) {
      const fs = a.fontSize ?? 18;
      ctx.font = `700 ${fs}px -apple-system, "SF Pro Display", Arial, sans-serif`;
      ctx.fillStyle = a.color;
      ctx.fillText(a.text, a.x1, a.y1 + fs);
    }
  }, []);

  const redrawAnnotations = useCallback((anns: Annotation[], draft?: Annotation | null) => {
    const ac = annCanvasRef.current;
    if (!ac) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = ac.getContext("2d")!;
    // Reset to identity, clear full buffer, then re-apply DPR scale so all
    // coordinates are in CSS pixels → crisp text/lines on Retina displays.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ac.width, ac.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    anns.forEach(a => drawAnnotation(ctx, a));
    if (draft) drawAnnotation(ctx, draft);
  }, [drawAnnotation]);

  useEffect(() => {
    const ac = annCanvasRef.current;
    if (!ac || ac.width === 0) return;
    // Just redraw — dimensions are managed in onAnnMouseDown using CSS pixels
    redrawAnnotations(annotations, annDraft);
  }, [annotations, annDraft, croppedShot, padding, redrawAnnotations]);

  const onAnnMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const pos: AnnPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // No tool active: drag an existing annotation
    if (!annTool) {
      const hit = [...annotations].reverse().find(a => hitAnnotation(a, pos.x, pos.y));
      if (hit) {
        annDragId.current = hit.id;
        annDragOffset.current = { x: pos.x - hit.x1, y: pos.y - hit.y1 };
        annDragging.current = true;
        e.preventDefault();
      }
      return;
    }

    // Size canvas buffer at CSS pixels × DPR for crisp Retina rendering.
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.round(rect.width);
    const cssH = Math.round(rect.height);
    const bufW = Math.round(cssW * dpr);
    const bufH = Math.round(cssH * dpr);
    if (canvas.width !== bufW || canvas.height !== bufH) {
      canvas.width = bufW;
      canvas.height = bufH;
      // Setting canvas.width resets context state — re-apply DPR scale
      canvas.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);
      redrawAnnotations(annotations, null);
    }

    // Eraser: click to delete nearest annotation
    if (annTool === "eraser") {
      const hit = [...annotations].reverse().find(a => hitAnnotation(a, pos.x, pos.y));
      if (hit) setAnnotations(prev => prev.filter(a => a.id !== hit.id));
      return;
    }

    // Text tool: show input overlay at click point, don't drag
    if (annTool === "text") {
      setTextInput(pos);
      setTextInputValue("");
      return;
    }
    annDragging.current = true;
    annStart.current = pos;
    if (annTool === "pen") penPoints.current = [pos];
    e.preventDefault();
  };

  const onAnnMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const pos: AnnPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // Drag existing annotation
    if (annDragId.current && annDragging.current) {
      const newX1 = pos.x - annDragOffset.current.x;
      const newY1 = pos.y - annDragOffset.current.y;
      setAnnotations(prev => prev.map(a => {
        if (a.id !== annDragId.current) return a;
        const dx = newX1 - a.x1, dy = newY1 - a.y1;
        return { ...a, x1: newX1, y1: newY1, x2: a.x2 + dx, y2: a.y2 + dy,
          points: a.points?.map(p => ({ x: p.x + dx, y: p.y + dy })) };
      }));
      return;
    }

    if (!annDragging.current || !annTool) return;
    if (annTool === "pen") {
      if (penPoints.current.length === 0) return; // safety: no start point yet
      penPoints.current = [...penPoints.current, pos];
      setAnnDraft({
        id: "draft", tool: "pen",
        x1: penPoints.current[0].x, y1: penPoints.current[0].y,
        x2: pos.x, y2: pos.y,
        color: annColor, lineWidth: annLineWidth,
        points: [...penPoints.current],
      });
    } else {
      setAnnDraft({
        id: "draft", tool: annTool,
        x1: annStart.current.x, y1: annStart.current.y,
        x2: pos.x, y2: pos.y,
        color: annColor, lineWidth: annLineWidth,
      });
    }
  };

  const onAnnMouseUp = (_e?: React.MouseEvent<HTMLCanvasElement>) => {
    if (annDragId.current) { annDragId.current = null; annDragging.current = false; return; }
    if (!annDragging.current || !annTool || !annDraft) { annDragging.current = false; return; }
    annDragging.current = false;
    setAnnotations(prev => [...prev, { ...annDraft, id: Date.now().toString() }]);
    setAnnDraft(null);
    if (annTool === "pen") penPoints.current = [];
  };

  // ── Global shortcut ──────────────────────────────────────────────────────
  useEffect(() => {
    register(SHORTCUT_ACCELERATOR, triggerCapture).catch(console.error);
    return () => { unregisterAll().catch(console.error); };
  }, []);

  useEffect(() => {
    try { localStorage.setItem("capturo_preferences", JSON.stringify(preferences)); } catch {}
  }, [preferences]);

  useEffect(() => {
    if (preferences.hideAtLaunch) {
      const timer = setTimeout(() => { invoke("hide_main_window").catch(() => {}); }, 500);
      return () => clearTimeout(timer);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Tray event ───────────────────────────────────────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<void>("tray-screenshot", () => triggerCapture()).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<void>("open-preferences", () => {
      setMode("idle");
      setActiveTab("preferences");
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // ── Cursor reset event (emitted from Rust before window shows) ────────────
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<void>("cursor-reset", () => {
      document.body.classList.add("capturo-reset-cursor");
      setTimeout(() => document.body.classList.remove("capturo-reset-cursor"), 900);
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // ── Undo keyboard shortcut ───────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        setAnnotations(prev => prev.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── History persistence ───────────────────────────────────────────────────
  useEffect(() => {
    if (!preferences.saveHistory) return;
    try { localStorage.setItem("capturo_history", JSON.stringify(history)); } catch {}
  }, [history, preferences.saveHistory]);

  // ── Repaint canvas + cursor fix when window becomes visible ───────────────
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) {
        if (imgRef.current) composite();
        document.body.classList.add("capturo-reset-cursor");
        setTimeout(() => document.body.classList.remove("capturo-reset-cursor"), 900);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [composite]);

  // ── Capture flow ─────────────────────────────────────────────────────────
  // Uses screencapture -i: hides window → native macOS crosshair → returns cropped PNG.
  // No fullscreen mode, no custom selection overlay needed.
  const triggerCapture = async () => {
    if (captureInProgress.current) return;  // prevent double-invoke
    captureInProgress.current = true;
    setMode("capturing");
    try {
      await new Promise(resolve => setTimeout(resolve, 250));
      const b64 = await invoke<string>("capture_interactive", { hideWindow: preferences.hideWindowOnCapture });
        // Force cursor reset — hold default cursor class for 900ms after window shows.
        document.body.classList.add("capturo-reset-cursor");
        setTimeout(() => document.body.classList.remove("capturo-reset-cursor"), 900);
      setCroppedShot(b64);
      setAnnotations([]); setAnnDraft(null); setAnnTool(null);
      setMode("idle");
      setActiveTab("editor");
      if (preferences.saveHistory) {
        setHistory(prev => [{
          id: Date.now().toString(), timestamp: Date.now(),
            croppedShot: b64, bg: BACKGROUNDS.find(b => b.id === 'candy') ?? BACKGROUNDS[0], padding: 48, radius: 12, shadow: 60, blur: 0,
        }, ...prev].slice(0, 40));
      }
      playDoneSound();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("permission_denied")) {
        showToast("Screen Recording denied. Grant permission to \"screencapture\" in System Settings → Privacy → Screen Recording.");
      } else if (!msg.includes("cancelled")) {
        showToast(`Capture failed: ${msg}`);
      }
      document.body.classList.add("capturo-reset-cursor");
      setTimeout(() => document.body.classList.remove("capturo-reset-cursor"), 900);
      setAnnTool(null);
      setMode("idle");
    } finally {
      captureInProgress.current = false;
    }
  };

  // ── Export (flatten annotations) ─────────────────────────────────────────
  const getFlatCanvas = (): HTMLCanvasElement | null => {
    const mc = canvasRef.current;
    const ac = annCanvasRef.current;
    if (!mc) return null;
    if (!ac || annotations.length === 0) return mc;
    const flat = document.createElement("canvas");
    flat.width = mc.width; flat.height = mc.height;
    const ctx = flat.getContext("2d")!;
    ctx.drawImage(mc, 0, 0);
    if (ac.width > 0 && ac.height > 0) {
      // Ann-canvas buffer is cssW*dpr × cssH*dpr; annotations are drawn in CSS pixel space.
      // Scale to output-canvas (full screenshot) resolution for export.
      const dpr = window.devicePixelRatio || 1;
      const sx = mc.width / (ac.width / dpr);
      const sy = mc.height / (ac.height / dpr);
      ctx.save(); ctx.scale(sx, sy);
      annotations.forEach(a => drawAnnotation(ctx, a));
      ctx.restore();
    } else {
      ctx.drawImage(ac, 0, 0, mc.width, mc.height);
    }
    return flat;
  };

  const handleCopy = async () => {
    const canvas = getFlatCanvas();
    if (!canvas) return;
    const b64 = canvas.toDataURL("image/png").split(",")[1];
    try {
      await invoke("copy_image_to_clipboard", { base64Png: b64 });
      playDoneSound();
      if (preferences.closeAfterCopy) await invoke("hide_main_window");
      else showToast("Copied to clipboard!");
    } catch (e) { showToast(`Copy failed: ${e}`); }
  };

  // ── Cmd+C shortcut — re-registers when annotations change for fresh closure ─
  useEffect(() => {
    if (!croppedShot) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        handleCopy();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [croppedShot, annotations]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    const canvas = getFlatCanvas();
    if (!canvas) return;
    const mime = preferences.saveFormat === "jpg" ? "image/jpeg" : "image/png";
    const b64 = canvas.toDataURL(mime, 0.92).split(",")[1];
    try {
      const filename = await invoke<string>("save_to_downloads", {
        base64Png: b64,
        fileExtension: preferences.saveFormat,
        filenameTemplate: preferences.defaultFileName,
      });
      playDoneSound();
      showToast(`Saved → Downloads/${filename}`);
    } catch (e) { showToast(`Save failed: ${e}`); }
  };

  const handleSaveAs = async () => {
    const canvas = getFlatCanvas();
    if (!canvas) return;
    const mime = preferences.saveFormat === "jpg" ? "image/jpeg" : "image/png";
    const b64   = canvas.toDataURL(mime, 0.92).split(",")[1];
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    try {
      const ext = preferences.saveFormat;
      const path = await save({ filters: [{ name: ext.toUpperCase(), extensions: [ext] }], defaultPath: makeFileName(preferences.defaultFileName, ext) });
      if (path) { await writeFile(path, bytes); playDoneSound(); showToast("Saved!"); }
    } catch { showToast("Save failed"); }
  };

  const startNew = () => { setCroppedShot(null); setAnnotations([]); setAnnTool(null); setTextInput(null); };

  const commitTextAnnotation = (val?: string) => {
    const value = (val ?? textInputValue).trim();
    if (textInput && value) {
      const ac = annCanvasRef.current;
      const fontSize = Math.max(12, annLineWidth * 5);
      // Ensure canvas is synced before committing so redraw positions correctly
      if (ac && ac.width === 300 && ac.height === 150) {
        const mc = canvasRef.current;
        if (mc) { ac.width = mc.offsetWidth || ac.width; ac.height = mc.offsetHeight || ac.height; }
      }
      setAnnotations(prev => [...prev, {
        id: Date.now().toString(), tool: "text",
        x1: textInput.x, y1: textInput.y, x2: textInput.x, y2: textInput.y,
        color: annColor, lineWidth: annLineWidth,
        text: value, fontSize,
      }]);
    }
    setTextInput(null); setTextInputValue("");
  };

  const handleUndo = () => setAnnotations(prev => prev.slice(0, -1));

  const loadFromHistory = (item: HistoryItem) => {
    setCroppedShot(item.croppedShot);
      setBg(item.bg); setPadding(item.padding); setRadius(item.radius); setShadow(item.shadow); setBlur(item.blur ?? 0);
    setAnnotations([]); setAnnTool(null);
    setActiveTab("editor");
  };

  const deleteFromHistory = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setHistory(prev => prev.filter(h => h.id !== id));
  };

  const hasShot = !!croppedShot;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* ── CAPTURING SPINNER ── */}
      {mode === "capturing" && (
        <div className="capture-screen">
          <div className="spinner" />
          <p>Preparing capture…</p>
        </div>
      )}

      {/* ── MAIN APP ── */}
      {mode === "idle" && (
        <>
          <header className="header">
            <div className="brand">
              <div className="brand-logo">
                <CapturoLogo />
              </div>
              <span className="brand-name">Captur<span className="brand-pop">o</span></span>
            </div>

            <nav className="header-tabs">
              <button className={`tab-btn${activeTab === "editor" ? " tab-btn--active" : ""}`} onClick={() => setActiveTab("editor")}>Editor</button>
              <button className={`tab-btn${activeTab === "history" ? " tab-btn--active" : ""}`} onClick={() => setActiveTab("history")}>
                History
                {history.length > 0 && <span className="tab-badge">{history.length}</span>}
              </button>
              <button className={`tab-btn${activeTab === "preferences" ? " tab-btn--active" : ""}`} onClick={() => setActiveTab("preferences")}>Preferences</button>
            </nav>

            <nav className="header-actions">
              {hasShot && activeTab === "editor" && (
                <button className="btn btn-ghost" onClick={startNew}>← New</button>
              )}
              <button className="btn btn-primary" onClick={triggerCapture}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="3" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.5"/><circle cx="7" cy="7.5" r="2" stroke="currentColor" strokeWidth="1.5"/><path d="M4 3V2.5C4 2.2 4.2 2 4.5 2h5C9.8 2 10 2.2 10 2.5V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                Screenshot
                <kbd>{SHORTCUT_LABEL}</kbd>
              </button>
            </nav>
          </header>

          <div className="workspace">

            {/* ── EDITOR TAB ── */}
            {activeTab === "editor" && (
              <>
                <main className="preview">
                  {hasShot ? (
                    <div className="canvas-wrap">
                      <div className="ann-toolbar">
                        <div className="ann-tools">
                          {([
                            { id: "box",       title: "Box",       icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.8"/></svg> },
                            { id: "circle",    title: "Circle",    icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.8"/></svg> },
                            { id: "arrow",     title: "Arrow",     icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 13L13 3M13 3H7M13 3v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg> },
                            { id: "highlight", title: "Highlight", icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="5" width="14" height="6" rx="1" fill="currentColor" fillOpacity="0.5"/></svg> },
                            { id: "pen",       title: "Pen",       icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 14l3-1 8-8-2-2-8 8-1 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M9 5l2 2" stroke="currentColor" strokeWidth="1.5"/></svg> },
                            { id: "text",      title: "Text",      icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M8 4v9M6 13h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg> },
                            { id: "eraser",    title: "Eraser",    icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 12l2.5-2.5 5-5 2 2-5 5-2.5 2.5-2-2z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M9.5 4.5l2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><path d="M2 14h5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg> },
                          ] as { id: AnnToolId; title: string; icon: React.ReactNode }[]).map(t => (
                            <button
                              key={t.id} title={t.title}
                              className={`ann-tool-btn${annTool === t.id ? " ann-tool-btn--active" : ""}`}
                              onClick={() => setAnnTool(prev => prev === t.id ? null : t.id)}
                            >{t.icon}<span className="ann-tool-label">{t.title}</span></button>
                          ))}
                        </div>
                        {annTool && (<>
                          <div className="ann-divider" />
                          <div className="ann-colors">
                            {ANN_COLORS.map(c => (
                              <button key={c} className={`ann-color${annColor === c ? " ann-color--active" : ""}`}
                                style={{ background: c }} onClick={() => setAnnColor(c)} />
                            ))}
                          </div>
                          <div className="ann-divider" />
                          <div className="ann-width-row">
                            <span className="ann-width-label">Size</span>
                            <input type="range" min={1} max={20} value={annLineWidth}
                              className="ann-width-slider" onChange={e => setAnnLineWidth(+e.target.value)} />
                            <span className="ann-width-val">{annLineWidth}</span>
                          </div>
                        </>)}
                        {annotations.length > 0 && (<>
                          <div className="ann-divider" />
                          <button className="ann-undo" onClick={handleUndo} title="Undo last annotation (⌘Z)">
                            <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 4.5h5a3.5 3.5 0 0 1 0 7H3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M4.5 2L2 4.5l2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            Undo
                          </button>
                          <button className="ann-clear" onClick={() => setAnnotations([])}>✕ Clear</button>
                        </>)}
                      </div>

                      <div className="canvas-stack">
                        <canvas ref={canvasRef} className="output-canvas" />
                        <canvas
                          ref={annCanvasRef}
                          className={`ann-canvas${(annTool || annotations.length > 0) ? " ann-canvas--active" : ""}`}
                          style={{
                            cursor: annTool === "text" ? "text" : annTool === "pen" ? PEN_CURSOR : annTool === "eraser" ? ERASER_CURSOR : annTool ? "crosshair" : annotations.length > 0 ? "grab" : "default",
                            pointerEvents: textInput ? "none" : undefined,
                          }}
                          onMouseDown={onAnnMouseDown}
                          onMouseMove={onAnnMouseMove}
                          onMouseUp={onAnnMouseUp}
                          onMouseLeave={onAnnMouseUp}
                        />
                        {textInput && (
                          <>
                            {/* Click-outside overlay to commit */}
                            <div
                              style={{ position: "absolute", inset: 0, zIndex: 19, cursor: "text" }}
                              onMouseDown={e => {
                                e.preventDefault();
                                const val = textInputValue;
                                commitTextAnnotation(val);
                              }}
                            />
                            <input
                              autoFocus
                              className="ann-text-input"
                              style={{
                                left: textInput.x,
                                top: textInput.y,
                                fontSize: Math.max(12, annLineWidth * 5),
                                color: annColor,
                              }}
                              value={textInputValue}
                              onChange={e => setTextInputValue(e.target.value)}
                              onMouseDown={e => e.stopPropagation()}
                              onKeyDown={e => {
                                if (e.key === "Enter") { e.preventDefault(); commitTextAnnotation(); }
                                if (e.key === "Escape") { setTextInput(null); setTextInputValue(""); }
                              }}
                              placeholder="Type text…"
                            />
                          </>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="idle-state">
                      <div className="idle-icon">
                        <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
                          <rect width="56" height="56" rx="16" fill="rgba(99,102,241,0.12)" />
                          <rect x="10" y="16" width="36" height="26" rx="4" stroke="#6366f1" strokeWidth="2" strokeDasharray="4 2"/>
                          <circle cx="28" cy="29" r="6" stroke="#8b5cf6" strokeWidth="2"/>
                          <path d="M20 16v-2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2" stroke="#6366f1" strokeWidth="2" strokeLinecap="round"/>
                        </svg>
                      </div>
                      <h2>No screenshot yet</h2>
                      <p>Press the button or use the shortcut to capture any area of your screen.</p>
                      <button className="btn btn-primary btn-lg" onClick={triggerCapture}>
                        Take a Screenshot
                        <span className="shortcut-badge">{SHORTCUT_LABEL}</span>
                      </button>
                      <div className="idle-tips">
                        <span className="tip">Native crosshair selector · Esc to cancel</span>
                        <span className="tip">Close window → hides to menu bar tray</span>
                      </div>
                    </div>
                  )}
                </main>

                {hasShot && (
                  <aside className="sidebar">
                    <div className="sidebar-inner">
                      <section className="ctrl-section">
                        <div className="section-label">Background</div>
                        <div className="bg-grid">
                          {BACKGROUNDS.map(b => (
                            <button key={b.id} title={b.label}
                              className={`swatch${bg.id === b.id ? " swatch--on" : ""}`}
                              style={{ background: b.css === "transparent" ? "repeating-conic-gradient(#444 0% 25%,#222 0% 50%) 0 0/12px 12px" : b.css }}
                              onClick={() => setBg(b)} />
                          ))}
                        </div>
                      </section>

                      <section className="ctrl-section">
                        <div className="ctrl-row"><label>Padding</label><span className="val">{padding}px</span></div>
                        <input type="range" min={0} max={120} value={padding} onChange={e => setPadding(+e.target.value)} className="slider" />
                      </section>

                      <section className="ctrl-section">
                        <div className="ctrl-row"><label>Radius</label><span className="val">{radius}px</span></div>
                        <input type="range" min={0} max={40} value={radius} onChange={e => setRadius(+e.target.value)} className="slider" />
                      </section>

                      <section className="ctrl-section">
                        <div className="ctrl-row"><label>Shadow</label><span className="val">{shadow}</span></div>
                        <input type="range" min={0} max={100} value={shadow} onChange={e => setShadow(+e.target.value)} className="slider" />
                      </section>

                      <section className="ctrl-section">
                        <div className="ctrl-row"><label>Blur</label><span className="val">{blur > 0 ? `${blur}px` : "Off"}</span></div>
                        <input type="range" min={0} max={12} value={blur} onChange={e => setBlur(+e.target.value)} className="slider" />
                      </section>

                      <div className="export-btns">
                        <button className="btn btn-copy btn-full" onClick={handleCopy}>
                          <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4"/><path d="M3 10V3a1 1 0 0 1 1-1h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
                          Copy
                        </button>
                        <button className="btn btn-primary btn-full" onClick={handleSave}>
                          <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M7.5 2v8M4 7l3.5 3.5L11 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 12h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
                          Save
                        </button>
                        <button className="btn btn-ghost btn-full" onClick={handleSaveAs}>
                          <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M2 10v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><path d="M7.5 2v8M4 6l3.5-3.5L11 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          Save As
                        </button>
                      </div>
                    </div>
                  </aside>
                )}
              </>
            )}

            {/* ── HISTORY TAB ── */}
            {activeTab === "history" && (
              <div className="history-panel">
                {history.length === 0 ? (
                  <div className="history-empty">
                    <div className="history-empty-icon">
                      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                        <rect width="48" height="48" rx="14" fill="rgba(99,102,241,0.10)"/>
                        <path d="M24 14v10l6 4" stroke="#6366f1" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                        <circle cx="24" cy="24" r="10" stroke="#8b5cf6" strokeWidth="2"/>
                      </svg>
                    </div>
                    <h3>No history yet</h3>
                    <p>Captured screenshots will appear here.</p>
                  </div>
                ) : (
                  <div className="history-grid">
                    {history.map(item => (
                      <div key={item.id} className="history-card" onClick={() => loadFromHistory(item)} title="Click to re-edit">
                        <div className="history-thumb-wrap">
                          <img className="history-thumb" src={`data:image/png;base64,${item.croppedShot}`} alt="screenshot" />
                          <button className="history-del" onClick={(e) => deleteFromHistory(item.id, e)} title="Delete screenshot">
                            <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M1 1l7 7M8 1L1 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
                          </button>
                        </div>
                        <div className="history-card-footer">
                          <span className="history-time">{formatTime(item.timestamp)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── PREFERENCES TAB ── */}
            {activeTab === "preferences" && (
              <div className="preferences-panel">
                <div className="preferences-card">
                  <div className="preferences-hero">
                    <CapturoLogo size={56} />
                    <div>
                      <h2>Capturo Preferences</h2>
                      <p>Shortcut: <kbd>{SHORTCUT_LABEL}</kbd> on macOS and Windows</p>
                    </div>
                  </div>

                  <section className="pref-section">
                    <div className="pref-section-title">Capture</div>
                    <label className="pref-toggle"><input type="checkbox" checked={preferences.hideWindowOnCapture} onChange={e => updatePref("hideWindowOnCapture", e.target.checked)} /><span>Hide Capturo while taking screenshot</span></label>
                    <label className="pref-toggle"><input type="checkbox" checked={preferences.hideAtLaunch} onChange={e => updatePref("hideAtLaunch", e.target.checked)} /><span>Always hide this window at launch</span></label>
                    <label className="pref-toggle"><input type="checkbox" checked={preferences.soundEffects} onChange={e => updatePref("soundEffects", e.target.checked)} /><span>Enable sound effects</span></label>
                  </section>

                  <section className="pref-section">
                    <div className="pref-section-title">Export</div>
                    <label className="pref-toggle"><input type="checkbox" checked={preferences.closeAfterCopy} onChange={e => updatePref("closeAfterCopy", e.target.checked)} /><span>Close screenshot panel after Copy</span></label>
                    <label className="pref-toggle"><input type="checkbox" checked={preferences.includeWatermark} onChange={e => updatePref("includeWatermark", e.target.checked)} /><span>Add Capturo watermark to screenshots</span></label>
                    <div className="pref-slider-row">
                      <div className="ctrl-row"><label>Watermark padding</label><span className="val">{preferences.watermarkPadding}px</span></div>
                      <input type="range" min={18} max={80} value={preferences.watermarkPadding} onChange={e => updatePref("watermarkPadding", +e.target.value)} className="slider" disabled={!preferences.includeWatermark} />
                    </div>
                    <div className="pref-row">
                      <span>Save format</span>
                      <div className="segmented">
                        <button className={preferences.saveFormat === "png" ? "seg-on" : ""} onClick={() => updatePref("saveFormat", "png")}>PNG</button>
                        <button className={preferences.saveFormat === "jpg" ? "seg-on" : ""} onClick={() => updatePref("saveFormat", "jpg")}>JPG</button>
                      </div>
                    </div>
                    <label className="pref-input-row">
                      <span>Default file name</span>
                      <input value={preferences.defaultFileName} onChange={e => updatePref("defaultFileName", e.target.value)} placeholder="Capturo-{datetime}" />
                    </label>
                  </section>

                  <section className="pref-section">
                    <div className="pref-section-title">History</div>
                    <label className="pref-toggle"><input type="checkbox" checked={preferences.saveHistory} onChange={e => updatePref("saveHistory", e.target.checked)} /><span>Save screenshot history</span></label>
                    <div className="pref-row">
                      <span>{history.length} screenshots stored</span>
                      <button className="btn btn-ghost" onClick={() => setHistory([])}>Clear History</button>
                    </div>
                  </section>
                </div>
              </div>
            )}

          </div>
        </>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
