import { t, getLanguage } from "./i18n.mjs";
import { createHash } from "node:crypto";

// Keep this page self-contained: the callback server closes after redemption.
const styles = `
  :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #283b45; background: #f8f7f3; }
  * { box-sizing: border-box; }
  body { margin: 0; min-width: 280px; min-height: 100vh; min-height: 100svh; display: flex; flex-direction: column; }
  .header { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; max-width: 1200px; margin: 0 auto; padding: 32px 40px; }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 21px; font-weight: 700; letter-spacing: -.8px; }
  .brand-icon { width: 30px; height: 30px; color: #ce5b48; }
  .brand-divider { width: 1px; height: 18px; margin: 0 4px; background: #d9d9d1; }
  .brand-cli { font: 500 13px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 0; color: #737d7e; }
  .local { display: flex; align-items: center; gap: 7px; color: #737d7e; font-size: 12px; }
  .local svg { width: 14px; height: 14px; }
  main { flex: 1; display: grid; place-items: center; padding: 42px 24px 70px; }
  .content { width: 100%; max-width: 560px; }
  .eyebrow { margin: 0 0 18px; text-align: center; font: 500 11px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 2px; color: #8a8e85; }
  .card { border: 1px solid #e2e3db; border-radius: 24px; padding: 42px 40px 30px; background: #fff; box-shadow: 0 8px 16px #283b4503, 0 24px 70px #283b4506; }
  .status-icon { display: grid; place-items: center; width: 72px; height: 72px; margin: 0 auto 26px; border: 1px solid #dce8de; border-radius: 50%; background: #f1f7f0; color: #3d7a56; box-shadow: 0 0 0 8px #f8fbf7; }
  .status-icon svg { width: 32px; height: 32px; }
  h1 { margin: 0; text-align: center; font-size: 30px; font-weight: 650; letter-spacing: -1px; line-height: 1.4; }
  .description { margin: 14px 0 28px; text-align: center; font-size: 14px; line-height: 1.9; color: #737d7e; }
  .terminal { border: 1px solid #354b55; border-radius: 12px; overflow: hidden; background: #283b45; color: #f7f7f2; }
  .terminal-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid #ffffff12; padding: 12px 16px; font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; color: #b6c2c4; }
  .dots { display: flex; gap: 5px; }
  .dots i { display: block; height: 6px; width: 6px; border-radius: 50%; background: #6c7e84; }
  .dots i:first-child { background: #d98572; }
  .dots i:nth-child(2) { background: #d0ba84; }
  .dots i:last-child { background: #8aaf99; }
  .terminal-content { padding: 23px 22px 24px; }
  .terminal-label { display: flex; align-items: center; gap: 9px; margin: 0 0 10px; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; color: #b8c9c9; }
  .prompt { color: #e99b82; }
  .next-step { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .next-step p { margin: 0; font-size: 17px; font-weight: 550; line-height: 1.6; }
  .next-step svg { flex-shrink: 0; width: 22px; height: 22px; color: #e99b82; }
  .terminal-note { margin: 8px 0 0; color: #b8c9c9; font-size: 12px; line-height: 1.8; }
  .steps { display: flex; align-items: center; justify-content: center; gap: 12px; margin: 24px 0 0; padding: 0; list-style: none; font-size: 11px; color: #737d7e; }
  .steps li { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
  .steps li + li::before { content: ""; width: 22px; height: 1px; margin-right: 7px; background: #e1e5df; }
  .step-check { color: #3d7a56; }
  .step-number { display: grid; place-items: center; width: 16px; height: 16px; border: 1px solid #d6dbd7; border-radius: 50%; font: 10px ui-monospace, SFMono-Regular, Consolas, monospace; }
  .close-note { margin: 22px 0 0; text-align: center; color: #7c8583; font-size: 12px; line-height: 1.8; }
  .footer { padding: 0 24px 26px; text-align: center; font: 10px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 1.3px; color: #8b9189; }
  @media (max-width: 600px) {
    .header { padding: 24px; }
    .brand { font-size: 19px; }
    .local { font-size: 11px; }
    main { padding: 32px 20px 48px; }
    .card { padding: 34px 22px 26px; border-radius: 20px; }
    h1 { font-size: 26px; }
    .description { font-size: 13px; }
    .terminal-content { padding: 20px 16px; }
    .next-step p { font-size: 16px; }
    .steps { gap: 8px; font-size: 10px; }
    .steps li + li::before { width: 12px; margin-right: 3px; }
  }
  @media (max-width: 350px) {
    .header { padding: 20px 16px; }
    .local { display: none; }
    main { padding-inline: 12px; }
    .card { padding-inline: 16px; }
    h1 { font-size: 23px; }
    .steps { gap: 5px; }
    .steps li + li::before { width: 6px; }
  }
`;

export const callbackPageCsp =
  "default-src 'none'; style-src 'sha256-" +
  createHash("sha256").update(styles).digest("base64") +
  "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const callbackPage = () => `<!doctype html>
<html lang="${getLanguage() === "zh" ? "zh-CN" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${t("授权回调已收到")} · DeckFlow CLI</title>
  <style>${styles}</style>
</head>
<body>
  <header class="header">
    <div class="brand" aria-label="DeckFlow CLI">
      <svg class="brand-icon" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="m4 9 12-6 12 6-12 6L4 9Z" fill="currentColor"/><path d="m4 16 12 6 12-6M4 23l12 6 12-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>DeckFlow</span><span class="brand-divider" aria-hidden="true"></span><span class="brand-cli">CLI</span>
    </div>
    <div class="local"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>${t("本地授权")}</div>
  </header>
  <main>
    <div class="content">
      <p class="eyebrow">${t("浏览器 → 终端")}</p>
      <section class="card" aria-labelledby="title">
        <div class="status-icon"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="m8 16 5.5 5.5L24 11" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <h1 id="title">${t("授权回调已收到")}</h1>
        <p class="description">${t("浏览器已完成这一步。")}<br>${t("回到终端，查看本次登录的最终结果。")}</p>
        <div class="terminal">
          <div class="terminal-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>DeckFlow CLI</span><span aria-hidden="true">⌘</span></div>
          <div class="terminal-content">
            <p class="terminal-label"><span class="prompt" aria-hidden="true">❯</span> deckflow auth login</p>
            <div class="next-step"><p>${t("请返回发起登录的终端")}</p><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6"/></svg></div>
            <p class="terminal-note">${t("CLI 将继续处理授权，并显示登录结果。")}</p>
          </div>
        </div>
        <ol class="steps" aria-label="${t("登录流程")}">
          <li><span class="step-check" aria-hidden="true">✓</span>${t("发起登录")}</li>
          <li><span class="step-check" aria-hidden="true">✓</span>${t("收到回调")}</li>
          <li><span class="step-number" aria-hidden="true">3</span>${t("终端确认")}</li>
        </ol>
      </section>
      <p class="close-note">${t("此页面可以安全关闭，无需刷新或重复授权。")}</p>
    </div>
  </main>
  <footer class="footer">${t("DECKFLOW · 从想法到演示")}</footer>
</body>
</html>`;
