/* Aide commune : installation de l'appli + notifications push */
(function () {
  const API = "https://fvrcgagumwkjfqctdfhs.supabase.co/functions/v1/";
  const VM = window.VM = {};
  VM.standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  VM.ios = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  let bip = null;
  addEventListener("beforeinstallprompt", e => { e.preventDefault(); bip = e; document.dispatchEvent(new Event("vm-install-ready")); });
  addEventListener("appinstalled", () => { bip = null; document.dispatchEvent(new Event("vm-installed")); });
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
})();
