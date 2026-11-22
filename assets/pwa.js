/* Aide commune : installation de l'appli + notifications push */
(function () {
  const API = "https://fvrcgagumwkjfqctdfhs.supabase.co/functions/v1/";
  const VM = window.VM = {};
  const post = (fn, body) => fetch(API + fn, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
  VM.standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  VM.ios = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  let bip = null;
  addEventListener("beforeinstallprompt", e => { e.preventDefault(); bip = e; document.dispatchEvent(new Event("vm-install-ready")); });
  addEventListener("appinstalled", () => {
    bip = null; document.dispatchEvent(new Event("vm-installed"));
    const t = VM.token(); if (t) post("push", { action: "installed", token: t });
  });
  VM.canPrompt = () => !!bip;
  VM.install = async () => {
    if (!bip) return false;
    bip.prompt();
    const r = await bip.userChoice.catch(() => ({ outcome: "dismissed" }));
    bip = null;
    return r.outcome === "accepted";
  };

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }

  VM.pushSupported = () =>
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && (!VM.ios() || VM.standalone());
  VM.pushState = async () => {
    if (!VM.pushSupported()) return "unsupported";
    if (Notification.permission === "denied") return "denied";
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      return sub && Notification.permission === "granted" ? "on" : "off";
    } catch { return "off"; }
  };
  const bytes = b64 => {
    const s = (b64 + "=".repeat((4 - b64.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
  };
  VM.enablePush = async token => {
    if (!VM.pushSupported()) throw new Error("unsupported");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("denied");
    const reg = await navigator.serviceWorker.ready;
    const k = await fetch(API + "push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "init" }) }).then(r => r.json());
    if (!k.public_key) throw new Error("key");
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(k.public_key) });
    const j = sub.toJSON();
    const r = await fetch(API + "push", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "subscribe", token: token || "", endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }) }).then(r => r.json());
    if (r.status !== "ok") throw new Error("save");
    return true;
  };
  VM.token = () => { try { return localStorage.getItem("vm_token") || ""; } catch { return ""; } };
  VM.saveToken = t => { try { if (t) localStorage.setItem("vm_token", t); } catch {} };
  // Bouton Admin : reconnaît l'e-mail de l'admin sans l'exposer (empreinte SHA-256).
  VM.checkAdmin = async email => {
    try {
      const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(email).trim().toLowerCase()));
      const h = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
      if (h === "d798d571e45b39bcdd8485b40d154ae7fae9e32ae12711bedfdfcb8ca1d2c798") localStorage.setItem("vm_isadmin", "1");
    } catch {}
  };
  VM.isAdmin = () => { try { return localStorage.getItem("vm_isadmin") === "1"; } catch { return false; } };
  VM.adminButton = () => {
    if (!VM.isAdmin() || document.getElementById("vm-admin")) return;
    const a = document.createElement("a");
    a.id = "vm-admin"; a.href = "/admin.html"; a.textContent = "Admin";
    a.style.cssText = "position:fixed;top:max(10px,env(safe-area-inset-top));right:10px;z-index:60;background:#C8923B;color:#241705;font:700 12px/1 Inter,system-ui,sans-serif;padding:7px 11px;border-radius:99px;text-decoration:none;box-shadow:0 6px 16px -6px rgba(0,0,0,.5)";
    document.body.appendChild(a);
  };
  document.addEventListener("DOMContentLoaded", VM.adminButton);
  // Suivi des visites (un visiteur compté une fois par jour et par page) — l'admin n'est pas compté
  addEventListener("load", () => {
    try {
      if (VM.isAdmin()) return;
      let v = localStorage.getItem("vm_vid");
      if (!v) { v = crypto.randomUUID(); localStorage.setItem("vm_vid", v); }
      const page = /app\.html$/.test(location.pathname) ? "app" : "site";
      const t = new URLSearchParams(location.search).get("t") || VM.token();
      post("push", { action: "hit", visitor: v, page, standalone: VM.standalone(), token: t || "" });
    } catch {}
  });
})();
