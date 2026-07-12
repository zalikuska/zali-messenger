import Foundation

struct WebAssets {

    // MARK: - Inline HTML (with embedded CSS + JS)

    static let html = #"""
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="dark">
    <meta name="theme-color" content="#0B0D12">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <link rel="manifest" href="manifest.json">
    <link rel="icon" href="icon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="icon.svg">
    <style id="zali-base-style">
:root {
    --lime: #cbff00;
    --lime-dim: rgba(203,255,0,.1);
    --lime-glow: rgba(203,255,0,.25);
    --lime-soft: rgba(203,255,0,.06);
    --bg: #090b0e;
    --sidebar: rgba(11,13,16,.9);
    --text: #f2f2f2;
    --text2: rgba(255,255,255,.5);
    --text3: rgba(255,255,255,.25);
    --border: rgba(255,255,255,.07);
    --red: #ff4d6d;
    --accent-rgb: 203,255,0;
    --r-msg: 18px;
    --contact-suggest-bg: rgba(8,10,14,.98);
    --contact-suggest-border: rgba(255,255,255,.18);
    --contact-suggest-shadow: 0 22px 48px rgba(0,0,0,.42);
    --contact-suggest-max-h: 340px;
    --contact-suggest-pad: 12px;
    --contact-suggest-gap: 8px;
    --contact-suggest-item-pad-y: 12px;
    --contact-suggest-item-pad-x: 12px;
    --contact-suggest-font: 14px;
    --contact-suggest-hint: rgba(255,255,255,.58);
    --msg-gap: 2;
    --control-h: 40px;
    --control-h-sm: 40px;
    --footer-dock-h: 68px;
    --footer-dock-gap: 12px;
    --footer-line-size: 1px;
    --footer-line-color: var(--border);
    --composer-inline-inset: 6px;
}

* {
    box-sizing: border-box;
}

html,
body {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    font-size: 14px;
    letter-spacing: 0;
    scrollbar-color: rgba(var(--accent-rgb),.45) rgba(255,255,255,.04);
}

::-webkit-scrollbar {
    width: 10px;
    height: 10px;
}

::-webkit-scrollbar-track {
    background: rgba(255,255,255,.03);
}

::-webkit-scrollbar-thumb {
    border: 2px solid rgba(0,0,0,.25);
    border-radius: 999px;
    background: linear-gradient(180deg, rgba(var(--accent-rgb),.82), rgba(var(--accent-rgb),.36));
}

button,
input {
    font: inherit;
}

button {
    border: 0;
}

.ui-icon {
    display: block;
    width: 1em;
    height: 1em;
    flex: 0 0 auto;
    color: currentColor;
    pointer-events: none;
}

[hidden] {
    display: none !important;
}

.app {
    width: 100vw;
    height: 100vh;
    display: grid;
    grid-template-rows: 40px 1fr;
    position: relative;
    background:
        radial-gradient(circle at 16% 12%, rgba(var(--accent-rgb),.12), transparent 22%),
        radial-gradient(circle at 72% 18%, rgba(255,255,255,.05), transparent 18%),
        radial-gradient(circle at 50% 120%, rgba(var(--accent-rgb),.08), transparent 28%),
        var(--bg);
}

.app::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image:
        linear-gradient(rgba(255,255,255,.015) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.015) 1px, transparent 1px);
    background-size: 64px 64px;
    -webkit-mask-image: radial-gradient(circle at center, rgba(0,0,0,.65), transparent 85%);
    mask-image: radial-gradient(circle at center, rgba(0,0,0,.65), transparent 85%);
    opacity: .35;
}

.titlebar {
    display: grid;
    grid-template-columns: 220px 1fr 220px;
    align-items: center;
    min-width: 0;
    padding: 0 14px;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, rgba(255,255,255,.04), rgba(0,0,0,.22));
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    -webkit-user-select: none;
}

.tb-c {
    min-width: 0;
    text-align: center;
    color: var(--text2);
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
}

.tb-brand {
    color: var(--text);
}

.tb-sep {
    margin: 0 8px;
    color: var(--text3);
}

.tb-chat {
    color: var(--lime);
}

.tb-r {
    display: flex;
    justify-content: flex-end;
}

.tb-l {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    min-width: 0;
}

.mobile-menu-btn {
    display: none;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(255,255,255,.04);
    color: var(--text);
    cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
    transition: transform .18s ease, border-color .18s ease, background .18s ease, color .18s ease, box-shadow .18s ease;
}

.mobile-menu-btn:hover,
.mobile-menu-btn.active {
    border-color: rgba(var(--accent-rgb), .28);
    background: rgba(var(--accent-rgb), .08);
    box-shadow: 0 0 0 2px var(--lime-dim);
}

.ws-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 128px;
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text2);
    font-size: 11px;
    font-weight: 700;
    background: rgba(255,255,255,.03);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 6px 18px rgba(0,0,0,.18);
}

.mobile-backdrop {
    position: fixed;
    inset: 0;
    z-index: 19;
    display: none;
    border: 0;
    padding: 0;
    background: rgba(0,0,0,.55);
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
}

/* Mobile bottom bar — Liquid Glass (App Store style). Mobile-only; desktop never renders it. */
.mobile-dock {
    position: fixed;
    left: 50%;
    bottom: calc(12px + env(safe-area-inset-bottom, 0px));
    z-index: 22;
    display: none;
    align-items: stretch;
    gap: 4px;
    width: min(100vw - 24px, 460px);
    padding: 6px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 30px;
    background:
        linear-gradient(180deg, rgba(255,255,255,.10), rgba(255,255,255,.02)),
        rgba(14,16,20,.55);
    box-shadow:
        0 20px 48px rgba(0,0,0,.42),
        0 2px 8px rgba(0,0,0,.28),
        inset 0 1px 0 rgba(255,255,255,.22),
        inset 0 -1px 0 rgba(0,0,0,.25);
    transform: translateX(-50%);
    backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
}

.mobile-dock-btn {
    position: relative;
    flex: 1 1 0;
    min-width: 0;
    min-height: 48px;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 6px 4px;
    border: 0;
    border-radius: 22px;
    background: transparent;
    color: var(--text2);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: .01em;
    text-transform: none;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: transform .22s cubic-bezier(.2,1.1,.3,1), background .24s ease, color .22s ease, box-shadow .24s ease;
}

.mobile-dock-ico {
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

.mobile-dock-btn svg {
    width: 23px;
    height: 23px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform .22s cubic-bezier(.2,1.2,.24,1), stroke-width .22s ease;
}

.mobile-dock-label {
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
}

.mobile-dock-btn:active {
    transform: scale(.94);
}

.mobile-dock-btn.active {
    color: #05210b;
    background:
        radial-gradient(circle at 30% 18%, rgba(255,255,255,.4), transparent 42%),
        linear-gradient(180deg, rgba(var(--accent-rgb), 1), rgba(var(--accent-rgb), .82));
    box-shadow:
        0 8px 20px rgba(var(--accent-rgb), .34),
        inset 0 1px 0 rgba(255,255,255,.4);
}

.mobile-dock-btn.active svg {
    stroke-width: 2.25;
}

body[data-ui-v2="off"] #mobileHubBtn {
    display: none;
}

.ws-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--red);
    box-shadow: 0 0 12px rgba(255, 77, 109, .6);
}

.ws-pill.on .ws-dot {
    background: var(--lime);
    box-shadow: 0 0 12px var(--lime-glow);
}

.body {
    min-height: 0;
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 16px;
    padding: 16px;
}

.sidebar {
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 18px;
    background:
        linear-gradient(180deg, rgba(255,255,255,.025), rgba(255,255,255,.01)),
        var(--sidebar);
    box-shadow: 0 14px 36px rgba(0,0,0,.14), inset 0 1px 0 rgba(255,255,255,.02);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
}

.brand {
    padding: 22px 22px 14px;
    color: var(--text);
    font-size: 20px;
    font-weight: 900;
    letter-spacing: .02em;
}

.brand em {
    color: var(--lime);
    font-style: normal;
}

.sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 22px 18px 14px 22px;
}

.sidebar-brand-stack {
    min-width: 0;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 10px;
}

.sidebar-head .brand {
    padding: 0;
    white-space: nowrap;
}

.hub-segment-nav {
    display: none;
    position: relative;
    align-items: center;
    gap: 5px;
    width: 100%;
    min-height: 38px;
    padding: 4px;
    border: 1px solid rgba(255,255,255,.09);
    border-radius: 999px;
    background:
        linear-gradient(180deg, rgba(255,255,255,.065), rgba(255,255,255,.025)),
        rgba(0,0,0,.18);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 10px 22px rgba(0,0,0,.16);
}

.hub-segment-indicator {
    position: absolute;
    z-index: 0;
    top: 4px;
    left: 0;
    width: 0;
    height: calc(100% - 8px);
    border-radius: 999px;
    background:
        radial-gradient(circle at 28% 16%, rgba(255,255,255,.36), transparent 30%),
        linear-gradient(180deg, rgba(var(--accent-rgb), .98), rgba(var(--accent-rgb), .78));
    box-shadow:
        0 10px 24px rgba(var(--accent-rgb), .24),
        inset 0 1px 0 rgba(255,255,255,.34);
    pointer-events: none;
    transform: translate3d(4px, 0, 0);
    transition: transform .58s cubic-bezier(.22, .61, .36, 1), width .28s ease, box-shadow .28s ease;
}

body[data-ui-v2="on"] .hub-segment-nav {
    display: flex;
}

body[data-ui-v2="on"] .mode-switch {
    display: none;
}

.hub-segment-btn {
    position: relative;
    z-index: 1;
    flex: 1 1 0;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 30px;
    padding: 0 8px;
    border-radius: 999px;
    background: transparent;
    color: var(--text2);
    font-size: 10px;
    font-weight: 950;
    letter-spacing: .08em;
    text-transform: uppercase;
    cursor: pointer;
    transition: transform .18s ease, color .22s ease, background .18s ease, box-shadow .18s ease;
}

.hub-segment-btn svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform .22s cubic-bezier(.2, 1.2, .24, 1), stroke-width .22s ease;
}

.hub-segment-btn:hover {
    color: var(--text);
    background: rgba(255,255,255,.055);
}

.hub-segment-btn.active {
    color: #030402;
    background: transparent;
    box-shadow: none;
}

.hub-segment-btn.active svg {
    stroke-width: 2.25;
    animation: segment-icon-pop .52s cubic-bezier(.2, 1.18, .2, 1) both;
}

.mode-switch {
    display: inline-flex;
    align-items: center;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255,255,255,.035);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
}

.mode-btn {
    height: 30px;
    padding: 0 12px;
    border-radius: 999px;
    background: transparent;
    color: var(--text2);
    font-size: 11px;
    font-weight: 900;
    letter-spacing: .08em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background .18s ease, color .18s ease, box-shadow .18s ease, transform .18s ease;
}

.mode-btn:hover {
    color: var(--text);
    background: rgba(255,255,255,.04);
}

.mode-btn.active {
    background: linear-gradient(180deg, rgba(var(--accent-rgb), .98), rgba(var(--accent-rgb), .82));
    color: #050505;
    box-shadow: 0 8px 18px rgba(var(--accent-rgb), .18);
}

.mode-btn:active {
    transform: translateY(1px);
}

.search-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 12px 10px;
    padding: 10px 12px 0;
}

.search-box {
    position: relative;
    flex: 1;
    min-width: 0;
}

.search-icon {
    position: absolute;
    left: 14px;
    top: 50%;
    width: 18px;
    height: 18px;
    transform: translateY(-50%);
    background-color: var(--text2);
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none'%3E%3Ccircle cx='11' cy='11' r='6.75' stroke='black' stroke-width='2.25'/%3E%3Cpath d='M16.25 16.25L20 20' stroke='black' stroke-width='2.25' stroke-linecap='round'/%3E%3C/svg%3E") center / contain no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none'%3E%3Ccircle cx='11' cy='11' r='6.75' stroke='black' stroke-width='2.25'/%3E%3Cpath d='M16.25 16.25L20 20' stroke='black' stroke-width='2.25' stroke-linecap='round'/%3E%3C/svg%3E") center / contain no-repeat;
    opacity: .9;
    pointer-events: none;
}

.search-input {
    width: 100%;
    height: 38px;
    padding: 0 14px 0 42px;
    border: 1px solid var(--border);
    border-radius: 10px;
    outline: none;
    background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.02));
    color: var(--text);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.03), 0 8px 18px rgba(0,0,0,.08);
    transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease, background .18s ease;
}

.search-input:focus {
    border-color: var(--lime);
    box-shadow: 0 0 0 2px var(--lime-dim);
}

.nav-label {
    padding: 0 18px 8px;
    color: var(--text3);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
}

.contact-status {
    margin: -4px 16px 8px;
    padding: 0 6px;
    min-height: 16px;
    color: var(--text2);
    font-size: 11px;
    line-height: 1.3;
}

.contact-status[data-tone="error"] {
    color: var(--red);
}

.contact-status[data-tone="success"] {
    color: var(--lime);
}

.contact-add-btn {
    width: 38px;
    height: 38px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 38px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(var(--accent-rgb),.95), rgba(var(--accent-rgb),.75));
    color: #050505;
    font-size: 20px;
    font-weight: 900;
    cursor: pointer;
    box-shadow: 0 8px 18px rgba(var(--accent-rgb),.14), inset 0 1px 0 rgba(255,255,255,.2);
    transition: transform .18s ease, box-shadow .18s ease, filter .18s ease, opacity .18s ease;
}

.contact-add-btn:hover {
    filter: brightness(1.03);
    box-shadow: 0 10px 22px rgba(var(--accent-rgb),.2), inset 0 1px 0 rgba(255,255,255,.22);
}

.contact-add-btn:active {
    transform: translateY(1px);
}

.contact-add-btn:disabled {
    opacity: .45;
    cursor: not-allowed;
    filter: grayscale(.2);
}

.contact-add-btn.is-empty {
    box-shadow: inset 0 1px 0 rgba(255,255,255,.2);
}

.contact-add-btn.is-active {
    background: rgba(255,255,255,.06);
    border-color: var(--lime);
    color: var(--lime);
    box-shadow: 0 0 0 2px var(--lime-dim);
}

.contacts-suggest-wrap {
    display: none;
    padding: 0 16px 8px;
    position: relative;
    z-index: 5;
}

.contacts-suggest-wrap:not([hidden]) {
    display: block;
}

.contacts-suggest-wrap[hidden] {
    display: none !important;
}

.contacts-suggest {
    display: flex;
    flex-direction: column;
    gap: var(--contact-suggest-gap);
    max-height: var(--contact-suggest-max-h);
    overflow: auto;
    padding: var(--contact-suggest-pad);
    border: 1px solid var(--contact-suggest-border);
    border-radius: 12px;
    background: var(--contact-suggest-bg);
    box-shadow: var(--contact-suggest-shadow);
    animation: suggest-drop .18s ease-out;
}

.contact-suggest-empty {
    padding: 12px 14px;
    border: 1px dashed rgba(255,255,255,.16);
    border-radius: 10px;
    color: var(--text2);
    font-size: 13px;
    line-height: 1.4;
    background: rgba(255,255,255,.03);
}

.contact-suggest-item {
    display: grid;
    grid-template-columns: 34px 1fr auto;
    gap: 10px;
    align-items: center;
    width: 100%;
    padding: var(--contact-suggest-item-pad-y) var(--contact-suggest-item-pad-x);
    border: 1px solid transparent;
    border-radius: 10px;
    background: rgba(255,255,255,.05);
    color: var(--text);
    cursor: pointer;
    text-align: left;
    transition: transform .18s ease, background .18s ease, border-color .18s ease;
}

.contact-suggest-item:hover {
    background: rgba(255,255,255,.1);
    border-color: rgba(var(--accent-rgb),.28);
}

.contact-suggest-ava {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--lime);
    color: #050505;
    font-size: 12px;
    font-weight: 900;
}

.contact-suggest-meta {
    min-width: 0;
}

.contact-suggest-name {
    font-weight: 800;
    line-height: 1.1;
    font-size: var(--contact-suggest-font);
}

.contact-suggest-hint {
    margin-top: 2px;
    color: var(--contact-suggest-hint);
    font-size: 11px;
}

.contact-suggest-plus {
    color: var(--lime);
    font-size: 20px;
    font-weight: 900;
    line-height: 1;
}

.contacts {
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    margin: 0 12px 12px;
    padding: 0 8px 10px;
}

body[data-nav-mode="servers"] .search-wrap,
body[data-nav-mode="servers"] .contacts-suggest-wrap {
    display: none;
}

body[data-nav-mode="servers"] .contacts {
    padding: 0 8px 10px;
}

.contact {
    display: grid;
    grid-template-columns: 38px 1fr auto;
    align-items: center;
    gap: 10px;
    min-width: 0;
    min-height: 50px;
    padding: 8px 10px 8px 8px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    cursor: pointer;
    transition: color .18s ease, opacity .18s ease, background .18s ease, box-shadow .18s ease, transform .18s ease;
    animation: contact-in .26s cubic-bezier(.2,.8,.2,1) both;
}

.contact:hover,
.contact.active {
    background: rgba(255,255,255,.03);
    color: var(--text);
}

.contact.active {
    background: rgba(var(--accent-rgb), .10);
    box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb), .18);
    animation: contact-active .24s cubic-bezier(.2,.8,.2,1) both;
}

.contact.active .ava {
    box-shadow:
        0 0 0 1px rgba(var(--accent-rgb), .18),
        0 0 0 4px rgba(var(--accent-rgb), .08);
    animation: avatar-pulse .55s ease-out both;
}

.contact.active .contact-name {
    color: var(--text);
}

.contact.active .contact-prev {
    color: var(--text2);
}

.contact:not(.active) {
    animation: none;
}

.ava,
.msg-ava,
.chat-hdr-ava {
    position: relative;
    z-index: 1;
    display: grid;
    place-items: center;
    border-radius: 50%;
    overflow: hidden;
    background: var(--lime);
    color: #050505;
    font-weight: 900;
    box-shadow: 0 0 0 1px rgba(255,255,255,.04);
}

.ava {
    width: 38px;
    height: 38px;
}

.contact-info {
    min-width: 0;
}

.avatar-img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
    border-radius: inherit;
}

.avatar-fallback {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    color: #050505;
    font-size: 16px;
    font-weight: 900;
    line-height: 1;
    text-transform: uppercase;
    letter-spacing: 0;
}

.me-ava {
    cursor: pointer;
}

.me-ava:hover {
    box-shadow:
        0 0 0 1px rgba(255,255,255,.08),
        0 0 0 6px rgba(var(--accent-rgb), .08);
}

.contact-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    align-self: center;
    justify-self: end;
}

.contact-remove {
    width: 24px;
    height: 24px;
    align-self: center;
    justify-self: end;
    border-radius: 50%;
    background: transparent;
    color: var(--text3);
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    transition: transform .18s ease, color .18s ease, background .18s ease, box-shadow .18s ease;
}

.contact-remove:hover {
    color: var(--red);
    background: rgba(255,255,255,.06);
    box-shadow: 0 0 0 2px rgba(255,77,109,.08);
}

.contact-mute-toggle,
.channel-mute-toggle {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: transparent;
    color: var(--text3);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    opacity: .55;
    transition: opacity .18s ease, color .18s ease, background .18s ease;
}

.contact-mute-toggle:hover,
.channel-mute-toggle:hover {
    opacity: 1;
    background: rgba(255,255,255,.06);
}

.contact-mute-toggle.muted,
.channel-mute-toggle.muted {
    color: var(--text2);
    opacity: 1;
}

.contact-name {
    overflow: hidden;
    color: var(--text);
    font-size: 13px;
    font-weight: 800;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.contact-prev {
    overflow: hidden;
    margin-top: 3px;
    color: var(--text2);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.badge {
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: 999px;
    display: grid;
    place-items: center;
    background: var(--lime);
    color: #050505;
    font-size: 10px;
    font-weight: 900;
    animation: badge-pop .22s cubic-bezier(.2,.9,.18,1) both;
}

.server-list {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
}

.server-item {
    position: relative;
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-width: 0;
    min-height: 58px;
    padding: 10px 12px 10px 10px;
    border: 1px solid transparent;
    border-radius: 16px;
    background: transparent;
    color: var(--text);
    cursor: pointer;
    box-shadow: none;
    transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease, background .18s ease, color .18s ease;
    animation: contact-in .26s cubic-bezier(.2,.8,.2,1) both;
    content-visibility: auto;
    contain-intrinsic-size: 62px;
}

.server-item:hover {
    background: rgba(255,255,255,.03);
    color: var(--text);
    transform: translateY(-1px);
}

.server-item.active {
    background: rgba(var(--accent-rgb), .10);
    border-color: rgba(var(--accent-rgb), .18);
    box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb), .10);
}

.server-item.active .server-avatar {
    box-shadow:
        0 0 0 1px rgba(var(--accent-rgb), .18),
        0 0 0 4px rgba(var(--accent-rgb), .08),
        0 10px 20px rgba(0,0,0,.16);
}

.server-item.active::before {
    content: '';
    position: absolute;
    left: -8px;
    top: 50%;
    width: 4px;
    height: 22px;
    border-radius: 999px;
    transform: translateY(-50%);
    background: var(--lime);
    box-shadow: 0 0 10px var(--lime-glow);
}

.server-avatar {
    position: relative;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: #fff;
    font-size: 18px;
    font-weight: 900;
    text-shadow: 0 1px 2px rgba(0,0,0,.22);
    box-shadow:
        0 0 0 1px rgba(255,255,255,.05),
        0 10px 20px rgba(0,0,0,.16);
}

.server-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
}

.server-name {
    color: var(--text);
    font-size: 13px;
    font-weight: 800;
    line-height: 1.15;
    word-break: break-word;
}

.server-prev {
    color: var(--text2);
    font-size: 11px;
    line-height: 1.3;
    white-space: normal;
    word-break: break-word;
}

.server-badge {
    align-self: center;
    justify-self: end;
    border: 2px solid var(--sidebar);
}

.server-create {
    background: rgba(255,255,255,.025);
    border-style: dashed;
    color: var(--lime);
}

.server-create-plus {
    width: 40px;
    height: 40px;
    border: 1px dashed rgba(var(--accent-rgb), .22);
    background: rgba(255,255,255,.03);
    color: var(--lime);
    font-size: 24px;
    line-height: 1;
    font-weight: 900;
}

.server-empty {
    display: grid;
    place-items: center;
    min-height: 100%;
    padding: 24px 0;
    text-align: center;
}

.me {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--footer-dock-h);
    margin: 0 12px var(--footer-dock-gap);
    padding: 12px 14px;
    border-top: 0;
    background: transparent;
}

.me::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: var(--footer-line-size);
    background: var(--footer-line-color);
    pointer-events: none;
}

.me-info {
    min-width: 0;
    flex: 1;
}

.me-name {
    font-weight: 900;
}

.me-sub {
    margin-top: 2px;
    color: var(--text2);
    font-size: 11px;
}

.online-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 5px;
    border-radius: 50%;
    background: var(--lime);
}

.online-dot.guest {
    background: #ffcc66;
    box-shadow: 0 0 12px rgba(255, 204, 102, .5);
}

.settings-btn {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 8px;
    background: rgba(255,255,255,.04);
    color: var(--text);
    cursor: pointer;
    border: 1px solid var(--border);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
    transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease, color .18s ease, background .18s ease;
}

.settings-btn:hover {
    border-color: var(--lime);
    color: var(--lime);
    box-shadow: 0 0 0 2px var(--lime-dim);
}

.main,
.view {
    min-width: 0;
    min-height: 0;
}

.main {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 18px;
    background:
        linear-gradient(180deg, rgba(255,255,255,.025), rgba(0,0,0,.16)),
        rgba(255,255,255,.01);
    box-shadow: 0 14px 36px rgba(0,0,0,.14), inset 0 1px 0 rgba(255,255,255,.02);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
}

.view {
    position: absolute;
    inset: 0;
    display: none;
}

.view.active {
    display: grid;
    animation: view-enter .24s cubic-bezier(.2,.8,.2,1) both;
}

#viewChat {
    grid-template-rows: auto auto minmax(0, 1fr);
    gap: 16px;
    padding: 16px 16px 0;
    background: rgba(0,0,0,.12);
}

#viewSettings {
    grid-template-rows: 72px 1fr;
    background: rgba(0,0,0,.16);
}

#viewHub {
    grid-template-rows: 1fr;
    padding: 18px;
    background:
        radial-gradient(circle at 16% 10%, rgba(var(--accent-rgb), .18), transparent 30%),
        radial-gradient(circle at 86% 6%, rgba(255,255,255,.07), transparent 22%),
        rgba(0,0,0,.16);
}

.hub-view {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
}

.hub-hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 20px;
    align-items: center;
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: 24px;
    background:
        linear-gradient(135deg, rgba(var(--accent-rgb), .13), transparent 42%),
        linear-gradient(180deg, rgba(255,255,255,.065), rgba(255,255,255,.025));
    box-shadow: 0 22px 56px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.05);
}

.hub-hero h2 {
    margin: 8px 0 10px;
    max-width: 680px;
    color: var(--text);
    font-size: clamp(28px, 5vw, 52px);
    line-height: .95;
    letter-spacing: -.05em;
}

.hub-hero p {
    max-width: 620px;
    margin: 0;
    color: var(--text2);
    font-size: 14px;
    line-height: 1.6;
}

.hub-orb {
    display: grid;
    place-items: center;
    width: clamp(108px, 18vw, 170px);
    aspect-ratio: 1;
    border: 1px solid rgba(var(--accent-rgb), .34);
    border-radius: 38%;
    background:
        radial-gradient(circle at 35% 28%, rgba(255,255,255,.52), transparent 18%),
        linear-gradient(145deg, rgba(var(--accent-rgb), 1), rgba(var(--accent-rgb), .46));
    color: #050505;
    font-size: 24px;
    font-weight: 950;
    letter-spacing: -.04em;
    box-shadow: 0 24px 54px rgba(var(--accent-rgb), .16), inset 0 1px 0 rgba(255,255,255,.44);
}

.hub-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
}

.hub-card {
    position: relative;
    overflow: hidden;
    min-height: 178px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 18px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 22px;
    background:
        radial-gradient(circle at 90% 0%, rgba(var(--accent-rgb), .16), transparent 34%),
        linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.02));
    color: var(--text);
    text-align: left;
    cursor: pointer;
    box-shadow: 0 18px 42px rgba(0,0,0,.16), inset 0 1px 0 rgba(255,255,255,.04);
    transition: transform .2s ease, border-color .2s ease, box-shadow .2s ease, background .2s ease;
}

.hub-card:hover {
    transform: translateY(-2px);
    border-color: rgba(var(--accent-rgb), .34);
    box-shadow: 0 24px 56px rgba(0,0,0,.22), 0 0 0 2px rgba(var(--accent-rgb), .06);
}

.hub-card-kicker {
    color: var(--lime);
    font-size: 10px;
    font-weight: 950;
    letter-spacing: .14em;
    text-transform: uppercase;
}

.hub-card strong {
    font-size: 24px;
    line-height: 1;
}

.hub-card span:not(.hub-card-kicker) {
    max-width: 430px;
    color: var(--text2);
    font-size: 13px;
    line-height: 1.5;
}

.hub-card em {
    margin-top: auto;
    color: var(--text);
    font-style: normal;
    font-size: 12px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: .08em;
}

.hub-components {
    display: grid;
    gap: 14px;
    padding: 18px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 22px;
    background:
        radial-gradient(circle at 12% 0%, rgba(var(--accent-rgb), .10), transparent 30%),
        linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.018));
    box-shadow: 0 18px 42px rgba(0,0,0,.14), inset 0 1px 0 rgba(255,255,255,.035);
}

.hub-components-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
}

.hub-components-head h3 {
    margin: 6px 0 0;
    color: var(--text);
    font-size: 22px;
    line-height: 1.05;
}

.hub-components-head > span {
    flex: none;
    color: var(--text3);
    font-size: 11px;
    font-weight: 900;
    letter-spacing: .08em;
    text-transform: uppercase;
}

.hub-components-list {
    display: grid;
    gap: 10px;
}

.hub-component-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(220px, .48fr);
    gap: 18px;
    align-items: start;
    padding: 14px;
    border: 1px solid rgba(255,255,255,.07);
    border-radius: 16px;
    background: rgba(255,255,255,.025);
}

.hub-component-main,
.hub-component-meta {
    min-width: 0;
}

.hub-component-top {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}

.hub-component-top strong {
    color: var(--text);
    font-size: 14px;
    line-height: 1.15;
}

.hub-component-top span,
.hub-component-version {
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    padding: 0 8px;
    border: 1px solid rgba(var(--accent-rgb), .16);
    border-radius: 999px;
    color: var(--lime);
    background: rgba(var(--accent-rgb), .07);
    font-size: 10px;
    font-weight: 900;
    text-transform: uppercase;
}

.hub-component-main p {
    margin: 8px 0 0;
    color: var(--text2);
    font-size: 12px;
    line-height: 1.45;
}

.hub-component-meta {
    display: grid;
    justify-items: end;
    gap: 8px;
    text-align: right;
}

.hub-component-meta small {
    color: var(--text3);
    font-size: 11px;
    line-height: 1.4;
}

.chat-hdr,
.logs-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding: 0 22px;
    border-bottom: 1px solid var(--border);
    background: rgba(255,255,255,.02);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    animation: row-fade .24s cubic-bezier(.2,.8,.2,1) both;
}

.chat-hdr-ava {
    width: 42px;
    height: 42px;
}

.chat-hdr-info {
    min-width: 0;
    flex: 1;
}

.chat-hdr-name,
.logs-title {
    color: var(--text);
    font-weight: 900;
}

.chat-hdr-name {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.chat-hdr-title {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
}

.chat-hdr-channel-icon {
    width: 15px;
    height: 15px;
}

.chat-hdr-count {
    flex: 0 0 auto;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text2);
    background: rgba(255,255,255,.03);
    font-size: 11px;
    font-weight: 800;
    white-space: nowrap;
}

.chat-hdr-sub {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-top: 3px;
    color: var(--text2);
    font-size: 12px;
}

.chat-hdr-desc {
    line-height: 1.2;
}

.chat-hdr-key {
    display: inline-block;
    max-width: 100%;
    color: var(--lime);
    font-family: "SF Mono", "Menlo", "Monaco", Consolas, monospace;
    font-size: 10px;
    line-height: 1.3;
    word-break: break-all;
    overflow-wrap: anywhere;
}

.chat-hdr-actions {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 8px;
}

#chatHdr:not(.server-mode) .chat-hdr-actions {
    margin-left: auto;
}

.server-settings-btn {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: rgba(255,255,255,.04);
    color: var(--text);
    cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
    transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease, color .18s ease, background .18s ease;
}

.chat-call-btn {
    width: 40px;
}

.server-settings-btn .ui-icon,
.settings-btn .ui-icon,
.attach-btn .ui-icon {
    width: 18px;
    height: 18px;
}

.server-settings-btn .ui-icon-phone {
    width: 19px;
    height: 19px;
    filter: drop-shadow(0 0 8px rgba(var(--accent-rgb), .16));
}

.attach-btn .ui-icon-paperclip {
    width: 20px;
    height: 20px;
    transform: rotate(-7deg);
    filter: drop-shadow(0 0 8px rgba(var(--accent-rgb), .14));
}

.server-settings-btn:hover {
    border-color: rgba(var(--accent-rgb), .28);
    background: rgba(var(--accent-rgb), .08);
    box-shadow: 0 0 0 2px var(--lime-dim);
}

#viewChat.server-mode {
    grid-template-rows: auto auto 1fr;
}

.server-channel-list {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
    justify-content: flex-start;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 12px 2px 28px;
    margin-right: -2px;
    scrollbar-width: thin;
    scrollbar-color: rgba(var(--accent-rgb), .35) transparent;
    scroll-snap-type: x proximity;
    -webkit-overflow-scrolling: touch;
}

.chat-hdr.server-mode {
    justify-content: flex-start;
    gap: 14px;
}

.chat-hdr.server-mode .server-channel-list {
    margin-left: auto;
    max-width: min(58vw, 860px);
    padding-top: 14px;
    padding-bottom: 28px;
}

.server-channel-list::-webkit-scrollbar {
    height: 8px;
}

.server-channel-list::-webkit-scrollbar-track {
    background: transparent;
}

.server-channel-list::-webkit-scrollbar-thumb {
    background: rgba(var(--accent-rgb), .28);
    border-radius: 999px;
}

.server-channel {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255,255,255,.03);
    color: var(--text2);
    cursor: pointer;
    flex: 0 0 auto;
    scroll-snap-align: start;
    transition: transform .18s ease, background .18s ease, border-color .18s ease, color .18s ease, box-shadow .18s ease;
    content-visibility: auto;
    contain-intrinsic-size: 44px;
}

.server-channel:hover {
    color: var(--text);
    border-color: rgba(var(--accent-rgb), .18);
    background: rgba(255,255,255,.05);
}

.server-channel.active {
    color: #050505;
    background: linear-gradient(180deg, rgba(var(--accent-rgb), .98), rgba(var(--accent-rgb), .82));
    border-color: rgba(var(--accent-rgb), .36);
    box-shadow: 0 8px 20px rgba(var(--accent-rgb), .22);
}

.server-channel-hash {
    display: inline-grid;
    place-items: center;
    width: 14px;
    height: 14px;
    font-size: 11px;
    font-weight: 900;
    opacity: .8;
}

.server-channel-list-icon {
    width: 13px;
    height: 13px;
}

.server-channel-name {
    font-size: 11px;
    font-weight: 900;
    letter-spacing: .02em;
    text-transform: uppercase;
}

.server-channel-hash.voice {
    color: var(--lime);
    font-size: 12px;
}

.voice-panel {
    display: grid;
    gap: 12px;
    padding: 0 16px;
    margin-top: -2px;
}

.voice-room-card {
    display: grid;
    gap: 14px;
    padding: 16px 18px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background:
        radial-gradient(circle at top right, rgba(var(--accent-rgb), .12), transparent 34%),
        rgba(255,255,255,.03);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 18px 42px rgba(0,0,0,.16);
}

.voice-room-card.active {
    border-color: rgba(var(--accent-rgb), .3);
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,.05),
        0 0 0 1px rgba(var(--accent-rgb), .06),
        0 18px 42px rgba(0,0,0,.16);
}

.voice-room-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
}

.voice-room-title {
    color: var(--text);
    font-size: 14px;
    font-weight: 900;
}

.voice-room-sub {
    margin-top: 4px;
    color: var(--text2);
    font-size: 12px;
}

.voice-room-state {
    flex: 0 0 auto;
    padding: 5px 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,.03);
    color: var(--text2);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .08em;
}

.voice-room-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
}

.voice-meter-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
}

.voice-meter {
    display: grid;
    gap: 8px;
    padding: 12px 12px 10px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 14px;
    background: rgba(255,255,255,.025);
}

.voice-meter-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
}

.voice-meter-name {
    color: var(--text2);
    font-size: 11px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: .08em;
}

.voice-meter-value {
    color: var(--text);
    font-size: 11px;
    font-weight: 900;
    letter-spacing: .04em;
}

.voice-meter-track {
    position: relative;
    height: 10px;
    overflow: hidden;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,.08);
    background:
        linear-gradient(90deg, rgba(255,255,255,.04), rgba(255,255,255,.02)),
        rgba(0,0,0,.22);
}

.voice-meter-fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: 0%;
    border-radius: inherit;
    background: linear-gradient(90deg, rgba(var(--accent-rgb), 1), rgba(var(--accent-rgb), .35));
    box-shadow: 0 0 18px rgba(var(--accent-rgb), .22);
    transition: width .08s linear;
}

.voice-meter-fill.remote {
    background: linear-gradient(90deg, rgba(99, 205, 255, 1), rgba(99, 205, 255, .32));
    box-shadow: 0 0 18px rgba(99, 205, 255, .18);
}

.voice-meter[data-level="0"] .voice-meter-fill {
    opacity: .55;
}

.voice-meter[data-level="0"] .voice-meter-value {
    color: var(--text3);
}

.voice-health {
    display: grid;
    gap: 10px;
}

.voice-health-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
}

.voice-health-card {
    display: grid;
    gap: 5px;
    min-height: 78px;
    padding: 12px 12px 11px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 14px;
    background:
        radial-gradient(circle at top right, rgba(255,255,255,.05), transparent 34%),
        rgba(255,255,255,.025);
}

.voice-health-card[data-tone="good"] {
    border-color: rgba(var(--accent-rgb), .22);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
}

.voice-health-card[data-tone="warn"] {
    border-color: rgba(255, 186, 73, .18);
}

.voice-health-card[data-tone="bad"] {
    border-color: rgba(255, 77, 109, .22);
}

.voice-health-card[data-tone="idle"] {
    opacity: .88;
}

.voice-health-name {
    color: var(--text3);
    font-size: 10px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: .12em;
}

.voice-health-value {
    color: var(--text);
    font-size: 12px;
    font-weight: 900;
    line-height: 1.15;
}

.voice-health-sub {
    color: var(--text2);
    font-size: 11px;
    line-height: 1.35;
}

.voice-btn {
    min-height: 34px;
    padding: 0 14px;
    border: 1px solid rgba(var(--accent-rgb), .16);
    border-radius: 999px;
    background: linear-gradient(180deg, rgba(var(--accent-rgb), .98), rgba(var(--accent-rgb), .84));
    color: #0b0b0b;
    font-size: 11px;
    font-weight: 900;
    letter-spacing: .08em;
    text-transform: uppercase;
    cursor: pointer;
    transition: transform .18s ease, box-shadow .18s ease, filter .18s ease, border-color .18s ease;
}

.voice-btn:hover {
    filter: brightness(1.05);
    box-shadow: 0 0 0 3px var(--lime-dim);
}

.voice-btn.danger {
    border-color: rgba(255,77,109,.24);
    background: linear-gradient(180deg, rgba(255,77,109,.96), rgba(255,77,109,.82));
    color: #fff;
}

.voice-room-participants {
    display: grid;
    gap: 8px;
}

.voice-trace {
    display: grid;
    gap: 8px;
}

.voice-trace-list {
    display: grid;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 14px;
    background: rgba(255,255,255,.02);
}

.voice-trace-line {
    display: flex;
    gap: 8px;
    align-items: baseline;
    min-width: 0;
    color: var(--text2);
    font-size: 10px;
    line-height: 1.3;
    word-break: break-word;
}

.voice-trace-ts {
    flex: 0 0 auto;
    color: var(--text3);
    font-variant-numeric: tabular-nums;
}

.voice-trace-stage {
    min-width: 0;
    color: var(--text2);
}

.voice-trace-success .voice-trace-stage {
    color: rgba(186, 255, 0, .92);
}

.voice-trace-warn .voice-trace-stage {
    color: rgba(255, 125, 154, .96);
}

.voice-trace-error .voice-trace-stage {
    color: rgba(255, 92, 118, .98);
}

.voice-room-label {
    color: var(--text3);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .08em;
}

.voice-participants {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.voice-participant {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255,255,255,.03);
    color: var(--text2);
    font-size: 11px;
    font-weight: 800;
}

.voice-participant.mine {
    border-color: rgba(var(--accent-rgb), .24);
    color: var(--text);
}

.voice-empty {
    color: var(--text3);
    font-size: 12px;
}

#viewChat .chat-hdr,
#viewChat .voice-panel,
#viewChat .msgs,
#viewChat .input-area {
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
}

#viewChat .chat-hdr {
    padding: 14px 18px;
    align-items: center;
    border-bottom: 1px solid var(--border);
}

#viewChat .voice-panel {
    padding: 0 18px 4px;
}

#viewChat .msgs {
    min-height: 0;
    padding: 16px 16px calc(var(--footer-dock-h) + var(--footer-dock-gap) + 16px);
    overflow-y: auto;
    scroll-padding-bottom: calc(var(--footer-dock-h) + var(--footer-dock-gap) + 16px);
}

#viewChat .input-area {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: var(--footer-dock-gap);
    min-height: var(--footer-dock-h);
    margin: 0;
    padding: 7px 0;
    border-top: 0;
    z-index: 2;
    background: transparent;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    transform: none;
}

#viewChat .input-area::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: var(--footer-line-size);
    background: var(--footer-line-color);
    pointer-events: none;
}

.settings-topbar {
    justify-content: space-between;
    align-items: flex-start;
    gap: 18px;
    padding-top: 14px;
    padding-bottom: 14px;
}

.settings-topcopy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.settings-kicker {
    color: var(--lime);
    font-size: 10px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: .14em;
}

.settings-lead {
    max-width: 760px;
    margin: 0;
    color: var(--text2);
    font-size: 12px;
    line-height: 1.5;
}

.hdr-btn,
.btn-flat {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: var(--control-h-sm);
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03));
    color: var(--text);
    cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 6px 18px rgba(0,0,0,.14);
    line-height: 1;
    transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease, background .18s ease;
}

.hdr-btn:hover,
.btn-flat:hover {
    border-color: var(--lime);
    box-shadow: 0 0 0 2px rgba(var(--accent-rgb),.08);
}

.settings-body {
    padding: 24px;
}

.settings-scroll {
    overflow-y: auto;
    overflow-x: hidden;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
}

.settings-shell {
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-width: 1280px;
    width: 100%;
    margin: 0 auto;
    padding-bottom: 48px;
}

.settings-card {
    position: relative;
    overflow: hidden;
    padding: 18px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background:
        linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015)),
        rgba(255,255,255,.02);
    box-shadow: 0 18px 48px rgba(0,0,0,.16);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    animation: card-rise .3s cubic-bezier(.2,.8,.2,1) both;
    content-visibility: auto;
    contain-intrinsic-size: 220px;
}

.settings-card::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(135deg, rgba(var(--accent-rgb),.08), transparent 28%);
    opacity: .6;
}

.settings-hero {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) auto;
    gap: 20px;
    align-items: center;
}

.settings-hero-copy {
    position: relative;
    z-index: 1;
}

.settings-hero-copy h2 {
    margin: 4px 0 8px;
    color: var(--text);
    font-size: 22px;
    line-height: 1.18;
}

.settings-hero-copy p {
    margin: 0;
    max-width: 760px;
    color: var(--text2);
    font-size: 13px;
    line-height: 1.6;
}

.settings-chips {
    position: relative;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
}

.settings-chip {
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255,255,255,.04);
    color: var(--text);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .08em;
}

.settings-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.05fr) minmax(360px, .95fr);
    gap: 20px;
    align-items: start;
}

.settings-column {
    display: grid;
    gap: 20px;
}

.settings-card-head {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 14px;
}

.settings-card-head--tight {
    align-items: center;
}

.settings-card-title {
    margin: 4px 0 0;
    color: var(--text);
    font-size: 15px;
    font-weight: 900;
}

.settings-card-note {
    flex: none;
    color: var(--text3);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .08em;
}

.settings-theme-grid {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
}

.settings-theme-grid .btn-theme {
    position: relative;
    isolation: isolate;
    overflow: hidden;
    min-height: 42px;
    padding: 0 14px;
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 12px;
    background-clip: padding-box;
    -webkit-background-clip: padding-box;
    color: #0b0b0b;
    cursor: pointer;
    font-size: 11px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: .08em;
    box-shadow: 0 10px 24px rgba(0,0,0,.18);
    transition: transform .18s ease, box-shadow .18s ease, filter .18s ease, border-color .18s ease;
    animation: chip-pop .22s cubic-bezier(.2,.9,.18,1) both;
}

.settings-theme-grid .btn-theme::before {
    content: "";
    position: absolute;
    inset: -1px;
    z-index: -1;
    border-radius: inherit;
    background: inherit;
}

.settings-theme-grid .btn-theme:hover {
    filter: saturate(1.08) brightness(1.04);
    border-color: rgba(255,255,255,.2);
    box-shadow: 0 0 0 2px rgba(255,255,255,.12);
}

.settings-theme-grid .btn-theme.active {
    border-color: rgba(255,255,255,.72);
    box-shadow:
        0 0 0 2px rgba(var(--accent-rgb), .22),
        0 14px 30px rgba(0,0,0,.24);
    transform: translateY(-1px);
}

.avatar-editor {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: 84px minmax(0, 1fr);
    gap: 16px;
    align-items: center;
}

.avatar-editor-preview {
    display: grid;
    place-items: center;
}

.avatar-preview {
    width: 72px;
    height: 72px;
    font-size: 24px;
    box-shadow:
        0 0 0 1px rgba(255,255,255,.04),
        0 0 0 6px rgba(var(--accent-rgb), .06);
}

.avatar-editor-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.avatar-crop-overlay {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(4, 6, 10, .78);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    opacity: 0;
    transition: opacity .18s ease;
}

.avatar-crop-overlay[hidden] {
    display: none;
}

.avatar-crop-overlay.visible {
    opacity: 1;
}

.avatar-crop-modal {
    width: min(360px, 100%);
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 20px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 24px;
    background: linear-gradient(180deg, rgba(22,24,28,.98), rgba(10,12,16,.98));
    box-shadow: 0 30px 90px rgba(0,0,0,.52), 0 0 0 1px rgba(var(--accent-rgb),.06);
    transform: translateY(8px) scale(.98);
    transition: transform .18s ease;
}

.avatar-crop-overlay.visible .avatar-crop-modal {
    transform: translateY(0) scale(1);
}

.avatar-crop-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.avatar-crop-head h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 800;
}

.avatar-crop-close {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 50%;
    background: rgba(255,255,255,.04);
    color: var(--text2);
    font-size: 16px;
    cursor: pointer;
    transition: background .18s ease, color .18s ease;
}

.avatar-crop-close:hover {
    background: rgba(255,255,255,.08);
    color: var(--text);
}

.avatar-crop-stage-wrap {
    display: grid;
    place-items: center;
}

.avatar-crop-stage {
    position: relative;
    width: 300px;
    height: 300px;
    border-radius: 20px;
    overflow: hidden;
    background: #000;
    cursor: grab;
    touch-action: none;
    box-shadow: 0 0 0 1px rgba(255,255,255,.08);
    user-select: none;
}

.avatar-crop-stage.dragging {
    cursor: grabbing;
}

/* The circle "hole" is drawn with a spread box-shadow rather than clipping the
   stage itself, so the square ring around it still shows the rest of the photo
   (dimmed) — the part that won't end up in the avatar. */
.avatar-crop-circle-guide {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 220px;
    height: 220px;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    border: 2px solid rgba(255,255,255,.4);
    box-shadow: 0 0 0 2000px rgba(4,6,10,.62);
    pointer-events: none;
}

.avatar-crop-img {
    position: absolute;
    left: 0;
    top: 0;
    max-width: none;
    pointer-events: none;
}

.avatar-crop-zoom-row {
    display: flex;
    align-items: center;
    gap: 10px;
}

.avatar-crop-zoom {
    flex: 1;
    accent-color: var(--lime);
}

.avatar-crop-zoom-icon {
    color: var(--text3);
    font-size: 14px;
    font-weight: 800;
    line-height: 1;
}

.avatar-crop-zoom-icon--big {
    font-size: 17px;
}

.avatar-crop-hint {
    margin: 0;
    color: var(--text3);
    font-size: 12px;
    line-height: 1.4;
    text-align: center;
}

.avatar-crop-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
}

.avatar-editor-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
}

.theme-lime { background: #cbff00; }
.theme-cyber { background: #ff0055; color: #fff !important; }
.theme-matrix { background: #00ff33; }
.theme-ocean { background: #00d2ff; }
.theme-mono { background: #fff; }
.theme-ember { background: linear-gradient(135deg, #ff7a2e, #ffe0b8); }
.theme-aurora { background: linear-gradient(135deg, #5bffc4, #1ba6ff); }
.theme-graphite { background: linear-gradient(135deg, #b4becd, #2a3039); color: #fff !important; }
.theme-rose { background: linear-gradient(135deg, #ff7397, #ffd1dc); }
.theme-violet { background: linear-gradient(135deg, #ae5cff 0%, #7433b3 58%, #2a124f 100%); color: #fff !important; }

.settings-control-box {
    position: relative;
    z-index: 1;
    padding: 10px 12px;
    border: 1px solid rgba(255,255,255,.05);
    border-radius: 14px;
    background: rgba(255,255,255,.02);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
}

.hub-segment-settings {
    display: grid;
    gap: 8px;
    margin: 12px 0;
}

.hub-segment-option {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    padding: 11px 12px;
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 14px;
    background: rgba(255,255,255,.025);
    cursor: pointer;
    transition: border-color .18s ease, background .18s ease, transform .18s ease;
}

.hub-segment-option:hover {
    border-color: rgba(var(--accent-rgb), .26);
    background: rgba(var(--accent-rgb), .055);
}

.hub-segment-option input {
    accent-color: var(--lime);
}

.hub-segment-option span {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.hub-segment-option strong {
    color: var(--text);
    font-size: 13px;
}

.hub-segment-option small {
    color: var(--text2);
    font-size: 11px;
    line-height: 1.4;
}

.settings-stack {
    position: relative;
    z-index: 1;
    display: grid;
    gap: 12px;
}

.settings-control-row {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr) 64px;
    gap: 12px;
    align-items: center;
}

.settings-label {
    color: var(--text2);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .08em;
}

.settings-value {
    color: var(--lime);
    font-size: 13px;
    font-weight: 900;
    text-align: right;
}

.settings-range {
    width: 100%;
    accent-color: var(--lime);
    cursor: pointer;
}

.settings-log-body {
    position: relative;
    z-index: 1;
    max-height: 320px;
    border: 1px solid rgba(255,255,255,.05);
    border-radius: 14px;
    background: rgba(0,0,0,.18);
}

.settings-input {
    width: 100%;
    min-height: var(--control-h);
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    outline: none;
    background: rgba(255,255,255,.03);
    color: var(--text);
    font-family: inherit;
    font-size: 14px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
    transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
}

.settings-input:focus {
    border-color: var(--lime);
    box-shadow: 0 0 0 3px var(--lime-dim);
}

.color-picker {
    display: grid;
    grid-template-columns: 128px minmax(0, 1fr);
    gap: 12px;
    align-items: center;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background: rgba(255,255,255,.02);
}

.color-picker--compact {
    grid-template-columns: 112px minmax(0, 1fr);
    padding: 10px;
}

.color-picker--collapsible {
    gap: 10px;
    align-items: stretch;
}

.color-picker--collapsible.is-collapsed {
    grid-template-columns: minmax(0, 1fr);
}

.color-picker-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.color-picker-summary {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
}

.color-picker-preview {
    width: 22px;
    height: 22px;
    flex: none;
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 999px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
}

.color-picker-copy {
    min-width: 0;
    display: grid;
    gap: 2px;
}

.color-picker-title {
    color: var(--text);
    font-size: 13px;
    font-weight: 900;
}

.color-picker-sub {
    color: var(--text3);
    font-size: 11px;
    line-height: 1.4;
}

.color-picker-toggle {
    min-width: 104px;
    padding-inline: 12px;
}

.color-picker-body {
    min-width: 0;
    display: grid;
    grid-template-columns: 112px minmax(0, 1fr);
    gap: 12px;
    align-items: center;
}

.color-picker--collapsible.is-collapsed .color-picker-body {
    display: none;
}

.color-wheel {
    --wheel-color: var(--lime);
    --thumb-x: 50%;
    --thumb-y: 50%;
    position: relative;
    width: 128px;
    aspect-ratio: 1;
    border: 0;
    border-radius: 50%;
    cursor: crosshair;
    background:
        radial-gradient(circle at center, rgba(0,0,0,.18), rgba(0,0,0,.28) 66%, transparent 67%),
        conic-gradient(from 0deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000);
    box-shadow:
        inset 0 0 0 1px rgba(255,255,255,.08),
        0 12px 28px rgba(0,0,0,.22);
    user-select: none;
    pointer-events: auto;
    touch-action: none;
    flex: none;
    z-index: 1;
}

.color-wheel::before {
    content: '';
    position: absolute;
    inset: 14px;
    border-radius: 50%;
    background:
        radial-gradient(circle at center, rgba(12,14,18,.88), rgba(12,14,18,.96) 70%, rgba(12,14,18,1));
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.05);
}

.color-wheel::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);
}

.color-wheel--small {
    width: 112px;
}

.color-wheel--tiny {
    width: 64px;
}

.color-wheel--tiny::before {
    inset: 8px;
}

.color-wheel--tiny .color-wheel-center {
    display: none;
}

.color-wheel--tiny .color-wheel-thumb {
    width: 14px;
    height: 14px;
}

.color-wheel-thumb {
    position: absolute;
    left: var(--thumb-x);
    top: var(--thumb-y);
    width: 18px;
    height: 18px;
    transform: translate(-50%, -50%);
    border: 2px solid #fff;
    border-radius: 50%;
    background: var(--wheel-color);
    box-shadow: 0 0 0 4px rgba(0,0,0,.24), 0 10px 20px rgba(0,0,0,.28);
    z-index: 1;
    pointer-events: none;
}

.color-wheel-center {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--text);
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .16em;
    z-index: 0;
    pointer-events: none;
}

.color-wheel *,
.color-wheel::before,
.color-wheel::after {
    pointer-events: none;
}

.color-picker-side {
    min-width: 0;
    display: grid;
    gap: 8px;
}

.role-color-editor {
    display: grid;
    min-width: 0;
}

.color-hex-input {
    text-transform: uppercase;
}

.color-picker-help {
    margin: 0;
}

.settings-textarea {
    width: 100%;
    min-height: 94px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    outline: none;
    resize: vertical;
    background: rgba(255,255,255,.03);
    color: var(--text);
    font-family: inherit;
    font-size: 14px;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
    transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
}

.settings-textarea:focus {
    border-color: var(--lime);
    box-shadow: 0 0 0 3px var(--lime-dim);
}

.settings-textarea--compact {
    min-height: 132px;
    resize: vertical;
    line-height: 1.45;
}

.settings-inline-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
}

.server-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 12px;
    background: rgba(4, 6, 10, .78);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    overflow-y: auto;
}

.server-overlay[hidden] {
    display: none;
}

.server-modal {
    width: min(100%, calc(100vw - 24px));
    height: calc(100vh - 24px);
    max-width: none;
    max-height: none;
    margin: auto;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 20px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 24px;
    background:
        radial-gradient(circle at top left, rgba(var(--accent-rgb),.11), transparent 28%),
        linear-gradient(180deg, rgba(22,24,28,.98), rgba(10,12,16,.98));
    box-shadow: 0 30px 90px rgba(0,0,0,.52), 0 0 0 1px rgba(var(--accent-rgb),.06);
}

.server-modal::before {
    content: '';
    position: absolute;
    inset: 12px;
    pointer-events: none;
    border-radius: 12px;
    border: 1px solid rgba(var(--accent-rgb), .08);
    background:
        radial-gradient(circle at 14% 8%, rgba(var(--accent-rgb), .10), transparent 22%),
        radial-gradient(circle at 88% 12%, rgba(255,255,255,.05), transparent 18%),
        linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,0));
    opacity: .7;
}

.server-modal-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    position: relative;
    z-index: 1;
    padding-bottom: 4px;
}

.server-modal-headcopy {
    min-width: 0;
}

.server-modal-kicker {
    display: inline-flex;
    margin-bottom: 6px;
    color: var(--lime);
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .18em;
    text-transform: uppercase;
}

.server-modal-head h2 {
    margin: 0;
    font-size: 26px;
    line-height: 1.1;
}

.server-modal-head p {
    margin: 8px 0 0;
    color: var(--text2);
    line-height: 1.5;
}

.server-modal-close {
    width: 40px;
    height: 40px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: rgba(255,255,255,.04);
    color: var(--text);
    cursor: pointer;
    font-size: 22px;
    line-height: 1;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
    transition: transform .16s ease, border-color .16s ease, background .16s ease;
}

.server-modal-close:hover {
    transform: translateY(-1px);
    border-color: rgba(var(--accent-rgb), .22);
    background: rgba(255,255,255,.06);
}

.server-modal-shell {
    min-height: 0;
    display: grid;
    grid-template-columns: 292px minmax(0, 1fr);
    gap: 18px;
    flex: 1;
    position: relative;
    z-index: 1;
}

.server-modal-sidebar {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 20px;
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 22px;
    background:
        radial-gradient(circle at top left, rgba(var(--accent-rgb), .08), transparent 32%),
        linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.015)),
        rgba(255,255,255,.02);
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,.04),
        0 14px 40px rgba(0,0,0,.18);
}

.server-modal-sidebar-head {
    display: grid;
    gap: 6px;
}

.server-modal-sidebar-kicker {
    color: var(--lime);
    font-size: 11px;
    font-weight: 900;
    letter-spacing: .18em;
    text-transform: uppercase;
}

.server-modal-sidebar-title {
    color: var(--text);
    font-size: 18px;
    font-weight: 900;
    line-height: 1.15;
}

.server-modal-sidebar-sub {
    color: var(--text2);
    font-size: 12px;
    line-height: 1.5;
}

.server-modal-nav {
    display: grid;
    gap: 10px;
}

.server-modal-nav-btn {
    display: grid;
    gap: 4px;
    width: 100%;
    padding: 13px 14px;
    border: 1px solid transparent;
    border-radius: 18px;
    background: rgba(255,255,255,.025);
    color: var(--text2);
    text-align: left;
    cursor: pointer;
    transition: border-color .16s ease, background .16s ease, transform .16s ease, color .16s ease, box-shadow .16s ease;
}

.server-modal-nav-btn:hover {
    color: var(--text);
    background: rgba(255,255,255,.05);
    transform: translateX(2px);
}

.server-modal-nav-btn.active {
    color: var(--text);
    border-color: rgba(var(--accent-rgb), .28);
    background:
        linear-gradient(90deg, rgba(var(--accent-rgb), .16), rgba(255,255,255,.03));
    box-shadow:
        0 0 0 1px rgba(var(--accent-rgb), .08),
        inset 0 1px 0 rgba(255,255,255,.05),
        0 16px 30px rgba(var(--accent-rgb), .06);
}

.server-modal-nav-btn[hidden] {
    display: none;
}

.server-modal-nav-label {
    display: block;
    font-weight: 900;
    font-size: 13px;
}

.server-modal-nav-desc {
    display: block;
    color: var(--text3);
    font-size: 11px;
    line-height: 1.4;
}

.server-modal-body {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    flex: 1;
}

.server-modal-grid {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    align-items: stretch;
    overflow-y: auto;
    padding-right: 4px;
}

.server-modal-section {
    min-width: 0;
    min-height: 0;
    display: flex;
}

.server-modal-card {
    min-width: 0;
    min-height: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px;
    border: 1px solid var(--border);
    border-radius: 22px;
    background:
        linear-gradient(180deg, rgba(255,255,255,.028), rgba(255,255,255,.016)),
        rgba(255,255,255,.02);
    position: relative;
    overflow: hidden;
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,.035),
        0 18px 46px rgba(0,0,0,.12);
}

.server-modal-card::before {
    content: '';
    position: absolute;
    inset: 0;
    height: 3px;
    background: linear-gradient(90deg, rgba(var(--accent-rgb), .6), rgba(255,255,255,.06));
    opacity: .65;
    pointer-events: none;
}

.server-modal-card > * {
    position: relative;
    z-index: 1;
}

.server-modal-section[hidden] {
    display: none;
}

.server-modal-grid.is-discover .server-discover-card {
    width: 100%;
    max-width: none;
}

.server-form {
    display: grid;
    gap: 12px;
}

.server-assets {
    display: grid;
    gap: 12px;
    margin-top: 12px;
}

.server-asset-card {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 12px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background:
        linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015)),
        rgba(255,255,255,.02);
}

.server-asset-preview {
    display: grid;
    place-items: center;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.08);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
}

.server-avatar-preview {
    width: 88px;
    height: 88px;
    border-radius: 50%;
    background: linear-gradient(180deg, rgba(var(--accent-rgb),.98), rgba(var(--accent-rgb),.82));
    color: #050505;
    font-size: 26px;
    font-weight: 900;
}

.server-banner-card {
    grid-template-columns: 150px minmax(0, 1fr);
}

.server-banner-preview {
    width: 150px;
    min-height: 88px;
    border-radius: 16px;
    background:
        radial-gradient(circle at 20% 20%, rgba(var(--accent-rgb), .36), transparent 28%),
        linear-gradient(135deg, rgba(255,255,255,.12), rgba(255,255,255,.04));
    color: var(--text);
    font-size: 16px;
    font-weight: 900;
    letter-spacing: .08em;
}

.server-asset-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 8px;
}

.server-asset-title {
    color: var(--text);
    font-weight: 900;
    font-size: 13px;
}

.server-asset-sub {
    color: var(--text2);
    font-size: 11px;
    line-height: 1.5;
}

.server-asset-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.server-link-card {
    display: grid;
    gap: 10px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background:
        linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015)),
        rgba(255,255,255,.02);
}

.server-link-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 8px;
    align-items: center;
}

.server-discover-head-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
}

.server-discover-toolbar {
    display: grid;
    gap: 8px;
}

.server-discover-list {
    display: grid;
    gap: 10px;
    min-height: 200px;
    flex: 1;
    max-height: none;
    min-height: 0;
    overflow-y: auto;
    padding-right: 4px;
}

.server-discover-row {
    display: grid;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: rgba(255,255,255,.02);
}

.server-discover-item {
    width: 100%;
    justify-content: flex-start;
    text-align: left;
}

.server-discover-item .server-meta {
    flex: 1;
    min-width: 0;
}

.server-discover-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
}

.server-discover-actions .btn-flat {
    min-width: 104px;
}

.server-toggle {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: rgba(255,255,255,.03);
    cursor: pointer;
}

.server-toggle input {
    width: 18px;
    height: 18px;
    accent-color: var(--lime);
}

.server-toggle strong {
    display: block;
    color: var(--text);
    font-size: 13px;
}

.server-toggle small {
    display: block;
    margin-top: 2px;
    color: var(--text2);
    font-size: 11px;
}

.server-member-add {
    display: grid;
    grid-template-columns: minmax(0, 1.25fr) 110px auto;
    gap: 8px;
}

.server-channel-create {
    display: grid;
    gap: 12px;
    position: relative;
    z-index: 3;
    isolation: isolate;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background:
        linear-gradient(180deg, rgba(var(--accent-rgb), .035), rgba(255,255,255,.015)),
        rgba(255,255,255,.02);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
}

.server-channel-create-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 2px;
}

.server-channel-create-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
}

.server-channel-create-title {
    color: var(--text);
    font-size: 13px;
    font-weight: 900;
}

.server-channel-create-sub {
    color: var(--text2);
    font-size: 11px;
}

.server-channel-create-body {
    display: grid;
    gap: 10px;
    padding-top: 2px;
}

.server-channel-create.is-collapsed .server-channel-create-body {
    display: none;
}

.server-channel-create .settings-input {
    position: relative;
    z-index: 4;
    min-width: 0;
    cursor: text;
    pointer-events: auto;
}

.server-channel-create-btn {
    position: relative;
    z-index: 4;
    justify-self: start;
    width: auto;
    min-height: var(--control-h);
    padding-inline: 16px;
    pointer-events: auto;
}

.server-channel-create-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
}

.server-channel-create .auth-btn.primary {
    min-width: 160px;
}

.server-role-create {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    position: relative;
    z-index: 3;
    isolation: isolate;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background:
        linear-gradient(180deg, rgba(var(--accent-rgb), .035), rgba(255,255,255,.015)),
        rgba(255,255,255,.02);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
}

.server-role-create-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 2px;
}

.server-role-create-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
}

.server-role-create-title {
    color: var(--text);
    font-size: 13px;
    font-weight: 900;
}

.server-role-create-sub {
    color: var(--text2);
    font-size: 11px;
}

.server-role-create-body {
    display: grid;
    gap: 10px;
    padding-top: 2px;
}

.server-role-create.is-collapsed .server-role-create-body {
    display: none;
}

.server-role-create .settings-input {
    position: relative;
    z-index: 4;
    min-width: 0;
    cursor: text;
    pointer-events: auto;
}

.server-role-create-btn {
    position: relative;
    z-index: 4;
    justify-self: start;
    width: auto;
    min-height: var(--control-h);
    padding-inline: 16px;
    pointer-events: auto;
}

.server-role-create .color-picker--compact {
    position: relative;
    z-index: 1;
    margin-top: 2px;
}

.server-role-create-actions {
    display: flex;
    justify-content: flex-start;
}

.server-role-perms {
    display: grid;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: rgba(255,255,255,.02);
}

.server-perm-group {
    display: grid;
    gap: 8px;
}

.server-perm-group-title {
    color: var(--text);
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .12em;
    text-transform: uppercase;
}

.server-roles-list {
    display: grid;
    gap: 10px;
    min-height: 180px;
    flex: 1;
    max-height: none;
    min-height: 0;
    overflow-y: auto;
    padding-right: 4px;
}

.server-channels-list {
    display: grid;
    gap: 10px;
    min-height: 180px;
    flex: 1;
    max-height: none;
    min-height: 0;
    overflow-y: auto;
    padding-right: 4px;
}

.server-channel-card {
    display: grid;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background:
        linear-gradient(180deg, rgba(255,255,255,.028), rgba(255,255,255,.015)),
        rgba(255,255,255,.02);
    content-visibility: auto;
    contain-intrinsic-size: 180px;
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,.035),
        0 12px 28px rgba(0,0,0,.08);
}

.server-channel-head {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) 132px auto auto;
    gap: 10px;
    align-items: center;
    min-height: 40px;
}

.server-channel-chip {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: rgba(var(--accent-rgb), .18);
    color: var(--accent);
    font-size: 12px;
    font-weight: 900;
}

.server-channel-chip-icon {
    width: 12px;
    height: 12px;
}

.server-channel-chip.voice {
    background: rgba(31, 167, 255, .18);
    color: #4ab9ff;
}

.server-channel-copy {
    min-width: 0;
    display: grid;
    gap: 4px;
}

.server-channel-name-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 132px;
    gap: 8px;
    align-items: stretch;
}

.server-channel-kind-select {
    min-width: 132px;
    height: var(--control-h);
    padding-top: 0;
    padding-bottom: 0;
    justify-self: stretch;
}

.server-channel-meta {
    color: var(--text2);
    font-size: 11px;
    line-height: 1.2;
}

.server-channel-controls {
    display: grid;
    grid-auto-flow: column;
    gap: 8px;
    justify-content: flex-end;
    align-self: center;
    align-items: center;
}

.server-channel-controls .btn-flat {
    min-height: var(--control-h);
    height: var(--control-h);
    align-self: center;
}

.server-channel-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
}

.server-channel-position {
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    align-self: center;
}

.server-channel-position-label {
    color: var(--text3);
    font-size: 9px;
    font-weight: 900;
    letter-spacing: .12em;
    text-transform: uppercase;
    white-space: nowrap;
}

.server-channel-position .settings-input {
    width: 92px;
    min-height: var(--control-h);
    height: var(--control-h);
    padding-inline: 10px 8px;
}

.server-channel-card .settings-input,
.server-channel-card .btn-flat,
.server-channel-card .server-channel-kind-select {
    box-sizing: border-box;
}

.server-channel-card .settings-input,
.server-channel-card .server-channel-kind-select {
    margin: 0;
}

.server-role-card {
    display: grid;
    gap: 12px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background:
        linear-gradient(180deg, rgba(255,255,255,.028), rgba(255,255,255,.015)),
        rgba(255,255,255,.02);
    content-visibility: auto;
    contain-intrinsic-size: 180px;
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,.035),
        0 12px 28px rgba(0,0,0,.08);
}

.server-role-head {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
}

.server-role-head--draft {
    cursor: pointer;
}

.server-role-chip {
    width: 16px;
    height: 16px;
    border-radius: 999px;
    box-shadow: 0 0 0 1px rgba(255,255,255,.08);
}

.server-role-name {
    overflow: hidden;
    font-weight: 800;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.server-role-meta {
    color: var(--text2);
    font-size: 11px;
}

.server-role-summary {
    margin-top: 4px;
    margin-left: 26px;
}

.server-role-controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
}

.server-role-body {
    display: grid;
    gap: 10px;
}

.server-role-card.draft-role.collapsed .server-role-body {
    display: none;
}

.server-role-toggle {
    min-height: 34px;
    padding-inline: 12px;
    white-space: nowrap;
    justify-self: end;
}

.server-role-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}

.server-role-card.owner-role {
    border-color: rgba(var(--accent-rgb), .20);
    background: rgba(var(--accent-rgb), .05);
}

.server-perm-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}

.server-perm-grid--dense {
    gap: 8px;
}

.server-perm-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: rgba(255,255,255,.02);
}

.server-perm-row--stacked {
    align-items: flex-start;
}

.server-perm-row--stacked span {
    min-width: 0;
}

.server-perm-row--stacked strong {
    display: block;
    color: var(--text);
    font-size: 13px;
}

.server-perm-row--stacked small {
    display: block;
    margin-top: 2px;
    color: var(--text3);
    font-size: 11px;
    line-height: 1.45;
}

.server-perm-row input {
    accent-color: var(--lime);
}

.server-members-list {
    min-height: 0;
    max-height: none;
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-right: 4px;
}

.server-members-list.is-loading {
    opacity: .65;
    pointer-events: none;
}

.server-member-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 124px 34px;
    gap: 8px;
    align-items: center;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: rgba(255,255,255,.02);
}

.server-member-name {
    overflow: hidden;
    color: var(--text);
    font-weight: 800;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.server-member-meta {
    color: var(--text2);
    font-size: 11px;
}

.server-member-role {
    width: 100%;
}

.server-member-remove {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: rgba(255,255,255,.04);
    color: var(--text);
    cursor: pointer;
    line-height: 1;
}

.server-member-remove:hover {
    color: var(--red);
    background: rgba(255,77,109,.08);
}

.server-member-row.owner {
    border-color: rgba(var(--accent-rgb), .22);
    background: rgba(var(--accent-rgb), .06);
}

.server-member-row.owner .server-member-remove,
.server-member-row.owner .server-member-role {
    opacity: .45;
    pointer-events: none;
}

.server-modal-error {
    min-height: 18px;
    color: var(--red);
    font-size: 12px;
}

.server-modal-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    padding: 12px 0 0;
    margin-top: auto;
    position: sticky;
    bottom: 0;
    z-index: 2;
    background: linear-gradient(180deg, rgba(10,12,16,0), rgba(10,12,16,.88) 44%, rgba(10,12,16,.98));
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
}

.server-modal-actions .auth-btn.primary {
    min-height: 40px;
}

.server-delete-btn {
    color: var(--red);
}

.settings-help {
    margin: 0;
    color: var(--text3);
    font-size: 11px;
    line-height: 1.55;
}

.crypto-key-value {
    display: inline-block;
    max-width: 100%;
    padding: 2px 8px;
    margin: 0 4px;
    border: 1px solid rgba(var(--accent-rgb), .18);
    border-radius: 999px;
    background: rgba(255,255,255,.04);
    color: var(--text);
    font-family: "SF Mono", "Menlo", "Monaco", Consolas, monospace;
    font-size: 11px;
    word-break: break-all;
    overflow-wrap: anywhere;
}

.device-list {
    display: grid;
    gap: 8px;
}

.device-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: rgba(255,255,255,.035);
}

.device-row strong,
.device-row small {
    display: block;
    min-width: 0;
    overflow-wrap: anywhere;
}

.device-row small {
    margin-top: 3px;
    color: var(--text2);
    font-size: 12px;
}

.settings-card--logs {
    min-height: 0;
}

.settings-card--danger {
    border-color: rgba(255,255,255,.08);
    background:
        linear-gradient(180deg, rgba(255,77,109,.08), rgba(255,255,255,.015)),
        rgba(255,255,255,.02);
}

.settings-card--danger .settings-help {
    max-width: 780px;
    margin-bottom: 14px;
}

.recent-accounts {
    display: grid;
    gap: 10px;
    margin: 0 0 14px;
}

.recent-accounts:empty {
    display: none;
}

.recent-accounts-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--text3);
    font-size: 10px;
    font-weight: 900;
    letter-spacing: .14em;
    line-height: 1;
    text-transform: uppercase;
}

.recent-accounts-title::after {
    content: '';
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, rgba(255,255,255,.12), transparent);
}

.recent-accounts-empty {
    padding: 12px 14px;
    border: 1px dashed rgba(255,255,255,.12);
    border-radius: 14px;
    color: var(--text3);
    font-size: 12px;
    line-height: 1.45;
    background: rgba(255,255,255,.025);
}

.recent-account-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 14px;
    align-items: center;
    min-height: 68px;
    padding: 12px 14px;
    border: 1px solid rgba(255,255,255,.115);
    border-radius: 18px;
    background:
        radial-gradient(circle at 4% 0%, rgba(var(--accent-rgb), .1), transparent 36%),
        linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.02));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.045);
}

.recent-account-row.is-active {
    border-color: rgba(var(--accent-rgb), .38);
    background:
        radial-gradient(circle at 4% 0%, rgba(var(--accent-rgb), .16), transparent 38%),
        linear-gradient(180deg, rgba(var(--accent-rgb), .08), rgba(255,255,255,.02));
    box-shadow: 0 0 0 1px rgba(var(--accent-rgb), .1), 0 12px 28px rgba(var(--accent-rgb), .08);
}

.recent-account-main {
    min-width: 0;
}

.recent-account-name {
    color: var(--text);
    font-size: 15px;
    font-weight: 800;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.recent-account-meta {
    margin-top: 2px;
    color: var(--text3);
    font-size: 11px;
}

.recent-account-actions {
    display: flex;
    gap: 8px;
    align-items: center;
}

.recent-account-switch,
.recent-account-remove {
    min-height: 36px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 800;
}

.recent-account-switch {
    min-width: 88px;
    padding: 0 14px;
    border-color: rgba(var(--accent-rgb), .22);
    background: rgba(var(--accent-rgb), .12);
    color: var(--accent);
}

.recent-account-switch:disabled {
    border-color: rgba(var(--accent-rgb), .28);
    background: rgba(var(--accent-rgb), .08);
    color: var(--text2);
    cursor: default;
    opacity: 1;
}

.recent-account-remove {
    width: 36px;
    padding: 0;
    border-radius: 14px;
    border-color: rgba(255,255,255,.095);
    background: rgba(255,255,255,.035);
    color: var(--text3);
    font-size: 18px;
    line-height: 1;
}

.recent-account-remove:hover {
    border-color: rgba(255,77,109,.34);
    color: var(--red);
    box-shadow: 0 0 0 2px rgba(255,77,109,.08);
}

.settings-logout {
    position: relative;
    z-index: 1;
    width: 100%;
    justify-content: center;
    border-radius: 12px;
    background: rgba(255,77,109,.08);
    border-color: rgba(255,77,109,.18);
    transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease, color .18s ease, background .18s ease;
}

.settings-logout:hover {
    border-color: var(--red);
    color: var(--red);
    box-shadow: 0 0 0 2px rgba(255,77,109,.12);
}

.settings-toggle {
    margin-top: 4px;
}

.settings-body .log-body {
    padding: 14px;
    font-size: 11px;
}

.msgs {
    min-height: 0;
    overflow-y: auto;
    padding: 18px 22px;
    overflow-anchor: none;
}

.msg-window-spacer {
    display: block;
    width: 100%;
    flex: 0 0 auto;
    pointer-events: none;
}

.msg {
    display: flex;
    gap: 9px;
    align-items: flex-end;
    position: relative;
    margin: 0 0 calc(var(--msg-gap) * 1px);
}

.server-msg {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    justify-content: flex-start;
    margin: 0 0 calc(var(--msg-gap) * 1px);
}

.msg.out {
    justify-content: flex-end;
}

.msg.call-msg .bwrap {
    width: fit-content;
    max-width: min(560px, 74%);
}

.msg.single,
.msg.group-start {
    margin-top: 12px;
}

.msg.group-mid,
.msg.group-end {
    margin-top: 2px;
}

.msg.group-start::before {
    content: "";
    position: absolute;
    left: 34px;
    right: 34px;
    top: -7px;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,.09) 18%, rgba(255,255,255,.09) 82%, transparent);
    pointer-events: none;
}

.msg.out.group-start::before {
    background: linear-gradient(90deg, transparent, rgba(var(--accent-rgb),.10) 18%, rgba(var(--accent-rgb),.10) 82%, transparent);
}

.msg-ava {
    width: 28px;
    height: 28px;
    margin-top: 0;
    font-size: 11px;
}

.server-msg-ava {
    width: 34px;
    height: 34px;
    margin-top: 2px;
    font-size: 12px;
}

.msg-ava-spacer {
    visibility: hidden;
}

.server-msg-ava-spacer {
    visibility: hidden;
}

.bwrap {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    width: fit-content;
    max-width: min(620px, 74%);
}

.msg.out .bwrap {
    align-items: flex-end;
}

.msg-time-anchor {
    position: relative;
}

.msg-time {
    position: absolute;
    left: calc(100% + 12px);
    right: auto;
    top: 50%;
    bottom: auto;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    flex: none;
    width: max-content;
    min-height: 14px;
    padding: 0;
    color: var(--text3);
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
    word-break: normal;
    overflow-wrap: normal;
    writing-mode: horizontal-tb;
    text-orientation: mixed;
    font-variant-numeric: tabular-nums;
    opacity: 0;
    transform: translateY(-50%);
    transition: opacity .16s ease, color .16s ease;
    pointer-events: none;
}

.msg.time-visible .msg-time {
    opacity: .56;
}

.msg:hover .msg-time,
.msg:focus-within .msg-time {
    opacity: .68;
}

.msg.out .msg-time {
    left: auto;
    right: calc(100% + 12px);
    color: var(--text3);
}

.call-card {
    display: grid;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: rgba(255,255,255,.03);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
}

.call-card-top {
    display: flex;
    align-items: center;
    gap: 10px;
}

.call-card-icon {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 10px;
    background: rgba(255,255,255,.06);
    font-size: 15px;
    flex: 0 0 auto;
}

.call-card-icon .ui-icon {
    width: 16px;
    height: 16px;
}

.call-card-copy {
    min-width: 0;
}

.call-card-title {
    color: var(--text);
    font-size: 13px;
    font-weight: 900;
}

.call-card-sub {
    margin-top: 2px;
    color: var(--text2);
    font-size: 11px;
}

.call-card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    color: var(--text3);
    font-size: 10px;
}

.server-msg-main {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    width: fit-content;
    max-width: min(820px, 88%);
}

.server-msg-meta {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 6px;
    min-width: 0;
}

.server-msg-name {
    color: var(--text);
    font-weight: 900;
    line-height: 1.2;
}

.server-msg-time {
    color: var(--text3);
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
}

.server-msg .bubble {
    max-width: 100%;
}

.server-msg .reaction-row {
    margin-top: 6px;
}

.bubble {
    position: relative;
    isolation: isolate;
    overflow-wrap: anywhere;
    padding: 10px 13px;
    border: 1px solid var(--border);
    border-radius: var(--r-msg);
    background: linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.04));
    color: var(--text);
    line-height: 1.45;
    box-shadow: 0 10px 24px rgba(0,0,0,.12);
}

.out .bubble {
    border: 1px solid transparent;
    background:
        linear-gradient(180deg, rgba(var(--accent-rgb),.98), rgba(var(--accent-rgb),.90)) padding-box,
        linear-gradient(180deg, rgba(255,255,255,.28), rgba(95,110,0,.18)) border-box;
    color: #111100;
    box-shadow:
        0 10px 24px rgba(0,0,0,.12),
        inset 0 1px 0 rgba(255,255,255,.24),
        inset 0 -1px 0 rgba(85, 104, 0, .10);
}

.bubble.media-card {
    padding: 10px;
    border-color: rgba(255,255,255,.06);
    background: #2b2d31;
    color: #dbdee1;
}

.out .bubble.media-card {
    border-color: rgba(255,255,255,.06);
    background: #2b2d31;
    color: #dbdee1;
}

.media-only {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 0;
    border: 0;
    background: transparent;
    max-width: min(360px, 72vw);
}

.msg.gif-only .bwrap {
    max-width: min(380px, 74%);
}

.msg.gif-only .msg-attachments {
    display: block;
    margin-top: 0;
    max-width: 100%;
}

.msg.gif-only .discord-media-shell {
    display: inline-grid;
    width: auto;
    max-width: 100%;
}

.reaction-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
    align-self: flex-start;
}

.msg.out .reaction-row {
    align-self: flex-end;
    justify-content: flex-end;
}

.reaction-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 22px;
    padding: 2px 8px 2px 7px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255,255,255,.06);
    color: var(--text);
    cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
}

.reaction-chip:hover,
.reaction-chip:focus-visible {
    border-color: var(--lime);
    box-shadow: 0 0 0 2px var(--lime-dim);
    outline: 0;
}

.reaction-chip.mine {
    border-color: rgba(var(--accent-rgb),.45);
    background: rgba(var(--accent-rgb),.14);
}

.reaction-emoji {
    display: inline-block;
    width: 15px;
    height: 15px;
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
    font-size: 13px;
    line-height: 15px;
    text-align: center;
    transform: translateY(-.5px);
}

.reaction-count {
    display: inline-block;
    min-width: 7px;
    color: rgba(255,255,255,.94);
    font-size: 11px;
    font-weight: 900;
    line-height: 15px;
    text-align: center;
    transform: translateY(.25px);
}

.reaction-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255,255,255,.06);
    color: var(--text);
    cursor: pointer;
    line-height: 1;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
}

.reaction-btn-emoji {
    display: block;
    width: 20px;
    height: 20px;
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
    font-size: 18px;
    line-height: 20px;
    text-align: center;
    transform: translate(-1px, -1px);
}

.reaction-btn:hover,
.reaction-btn:focus-visible {
    border-color: var(--lime);
    box-shadow: 0 0 0 2px var(--lime-dim);
    outline: 0;
}

.reaction-btn.active {
    border-color: rgba(var(--accent-rgb),.55);
    background: rgba(var(--accent-rgb),.16);
}

.reaction-menu {
    position: fixed;
    z-index: 140;
    display: none;
    gap: 4px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: rgba(10,12,15,.96);
    box-shadow: 0 18px 42px rgba(0,0,0,.38);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    transform: translateY(2px) scale(.98);
    transform-origin: center bottom;
    opacity: 0;
    pointer-events: none;
}

.reaction-menu.visible {
    display: flex;
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0) scale(1);
    transition: opacity .14s ease, transform .14s ease;
}

.reaction-menu .reaction-btn {
    flex: none;
}

.msg-text {
    white-space: pre-wrap;
}

.msg-text a,
.msg-attachments a,
.msg-link-previews a {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
}

.msg-attachments {
    display: grid;
    gap: 10px;
    margin-top: 8px;
}

.msg-attachments:first-child {
    margin-top: 0;
}

.media,
.media-tenor iframe {
    display: block;
    width: 100%;
    border: 0;
    border-radius: calc(var(--r-msg) - 6px);
    background: rgba(0,0,0,.18);
}

.media-img,
.media-video {
    max-width: 100%;
}

.media-video {
    width: 100%;
    max-height: 360px;
}

.media-tenor {
    overflow: hidden;
    min-height: 220px;
}

.media-tenor iframe {
    width: 100%;
    height: 100%;
}

.media-tenor-pending {
    display: grid;
    place-items: center;
    gap: 8px;
    padding: 18px;
    background: linear-gradient(145deg, rgba(255,255,255,.08), rgba(255,255,255,.03));
}

.tenor-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 120px;
    padding: 10px 14px;
    border: 1px solid rgba(0,0,0,.14);
    border-radius: 10px;
    background: rgba(0,0,0,.28);
    color: #fff;
    font-size: 13px;
    font-weight: 800;
    box-shadow: 0 6px 18px rgba(0,0,0,.14);
}

.tenor-hint {
    color: var(--text2);
    font-size: 12px;
}

.discord-media-shell {
    overflow: hidden;
    border-radius: calc(var(--r-msg) - 6px);
    background: #000;
    border: 1px solid rgba(255,255,255,.04);
    box-shadow: 0 1px 0 rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.02);
}

.discord-media-shell video,
.discord-media-shell img {
    display: block;
    width: 100%;
    max-width: 100%;
    height: auto;
}

.discord-media-shell-video {
    min-height: 0;
}

.discord-media-shell-video video {
    width: 100%;
    height: 100%;
    max-height: 360px;
    object-fit: contain;
}

.discord-media-shell-gif {
    display: inline-grid;
    width: auto;
    max-width: min(360px, 72vw);
    background: transparent;
    min-height: 0;
    height: auto;
}

.discord-media-shell-gif video {
    width: auto !important;
    max-width: min(360px, 72vw);
    height: auto !important;
    max-height: 340px;
    object-fit: contain;
    background: transparent !important;
}

.discord-media-shell-image.discord-media-shell-gif img,
.discord-media-shell-image .media-gif-like {
    width: auto;
    max-width: min(360px, 72vw);
    height: auto;
    max-height: 340px;
    object-fit: contain;
    background: transparent;
}

.discord-media-shell-image img {
    object-fit: cover;
}

.discord-media-shell-video video {
    background: #000;
}

.discord-media-shell-gif {
    background: transparent;
}

.media-unknown {
    padding: 10px 12px;
    border: 1px dashed var(--border);
    border-radius: calc(var(--r-msg) - 6px);
    color: var(--text2);
}

.file-chip {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid transparent;
    border-radius: var(--r-msg);
    background:
        linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.04)) padding-box,
        linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,.05)) border-box;
    color: var(--text);
    text-decoration: none;
    box-shadow:
        0 10px 24px rgba(0,0,0,.10),
        inset 0 1px 0 rgba(255,255,255,.06);
}

.file-chip:hover,
.file-chip:focus-visible {
    box-shadow:
        0 10px 24px rgba(0,0,0,.10),
        inset 0 1px 0 rgba(255,255,255,.08),
        0 0 0 2px rgba(var(--accent-rgb),.10);
    outline: 0;
}

.file-chip-name {
    font-weight: 700;
    line-height: 1.2;
}

.file-chip-size {
    color: var(--text2);
    font-size: 11px;
    line-height: 1.2;
}

.file-chip.compact {
    padding: 9px 11px;
}


.btime {
    margin-top: 2px;
    color: var(--text3);
    font-size: 10px;
}

.out .btime {
    text-align: right;
}

.date-sep {
    display: flex;
    justify-content: center;
    margin: 18px 0;
}

.date-sep span {
    padding: 5px 10px;
    border-radius: 999px;
    background: rgba(255,255,255,.06);
    color: var(--text2);
    font-size: 11px;
    font-weight: 800;
    animation: chip-pop .22s cubic-bezier(.2,.9,.18,1) both;
}

.input-area {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px 18px 16px;
    border-top: 1px solid rgba(255,255,255,.08);
    background: transparent;
}

.draft-attachments {
    display: none;
    flex-wrap: wrap;
    gap: 10px;
}

.draft-attachments.has-items {
    display: flex;
}

.draft-att {
    position: relative;
    width: 128px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: rgba(255,255,255,.03);
    animation: card-rise .22s cubic-bezier(.2,.8,.2,1) both;
    content-visibility: auto;
    contain-intrinsic-size: 140px;
}

.draft-att-remove {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: rgba(0,0,0,.6);
    color: #fff;
    cursor: pointer;
    transition: transform .18s ease, background .18s ease, color .18s ease;
}

.draft-att-remove:hover {
    background: rgba(0,0,0,.8);
    color: var(--lime);
}

.draft-att .media,
.draft-att .file-chip {
    width: 100%;
    max-height: 84px;
    min-height: 84px;
    object-fit: cover;
}

.draft-att .discord-media-shell {
    width: 100%;
    height: 84px;
}

.draft-att .discord-media-shell video,
.draft-att .discord-media-shell img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.draft-att .file-chip {
    display: grid;
    place-items: center;
    text-align: center;
    padding: 10px;
}

.draft-att-name {
    margin-top: 8px;
    overflow: hidden;
    color: var(--text2);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.input-bar {
    display: grid;
    grid-template-columns: 40px 1fr 40px;
    align-items: center;
    gap: 10px;
    width: calc(100% - (var(--composer-inline-inset) * 2));
    margin: 0 var(--composer-inline-inset);
    height: 54px;
    padding: 8px 8px;
    border: 1px solid rgba(255,255,255,.055);
    border-radius: 12px;
    background:
        linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012)),
        rgba(8,10,13,.9);
    box-shadow:
        inset 0 1px 0 rgba(255,255,255,.035);
}

#msgInput {
    min-width: 0;
    height: 36px;
    max-height: 140px;
    resize: none;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    line-height: 1.35;
    padding: 7px 0 5px;
}

.attach-btn,
.send-btn {
    width: 40px;
    height: 36px;
    border-radius: 11px;
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease, background .18s ease, color .18s ease;
}

.attach-btn {
    background: rgba(255,255,255,.04);
    color: var(--text);
    border: 1px solid var(--border);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
}

.attach-btn:hover,
.input-bar.drop-active {
    border-color: var(--lime);
    box-shadow: 0 0 0 2px var(--lime-dim);
}

.send-btn {
    background: var(--lime);
    color: #050505;
    box-shadow: 0 0 18px rgba(var(--accent-rgb),.28);
    transform-origin: bottom right;
}

.send-btn:hover {
    box-shadow: 0 0 0 2px rgba(var(--accent-rgb),.12);
}

.send-btn:disabled {
    cursor: default;
    opacity: .35;
}

.log-body,
.settings-body {
    min-height: 0;
    overflow-y: auto;
}

.log-body {
    padding: 14px 18px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
}

.log-entry {
    padding: 7px 0;
    border-bottom: 1px solid rgba(255,255,255,.04);
    color: var(--text2);
}

.log-SUCCESS {
    color: var(--lime);
}

.log-ERROR {
    color: var(--red);
}

.log-WARN {
    color: #ffcc66;
}

.ts {
    margin-right: 8px;
    color: var(--text3);
}

@media (max-width: 1100px) {
    .settings-hero,
    .settings-grid {
        grid-template-columns: 1fr;
    }

    .server-modal-shell {
        grid-template-columns: 1fr;
    }

    .settings-chips {
        justify-content: flex-start;
    }

    .settings-control-row {
        grid-template-columns: 72px minmax(0, 1fr) 56px;
    }

    .server-perm-grid {
        grid-template-columns: 1fr;
    }
}

@media (max-width: 760px) {
    #viewSettings {
        grid-template-rows: auto 1fr;
    }

    #viewHub {
        padding: 12px;
    }

    .hub-hero {
        grid-template-columns: 1fr;
        padding: 18px;
        border-radius: 20px;
    }

    .hub-orb {
        width: 110px;
        border-radius: 32%;
    }

    .hub-grid {
        grid-template-columns: 1fr;
    }

    .hub-components {
        padding: 14px;
        border-radius: 18px;
    }

    .hub-components-head,
    .hub-component-item {
        grid-template-columns: 1fr;
    }

    .hub-components-head {
        display: grid;
    }

    .hub-component-meta {
        justify-items: start;
        text-align: left;
    }

    .settings-topbar {
        flex-direction: column;
        align-items: stretch;
    }

    .settings-body {
        padding: 16px;
    }

    .settings-card {
        padding: 16px;
        border-radius: 16px;
    }

    .server-modal {
        width: min(100%, calc(100vw - 12px));
        height: calc(100vh - 12px);
        padding: 14px;
        border-radius: 18px;
    }

    .server-modal-head {
        flex-direction: column;
    }

    .server-modal-shell {
        gap: 12px;
    }

    .server-modal-sidebar {
        padding: 14px;
    }

    .server-modal-grid {
        max-height: none;
        overflow: visible;
        padding-right: 0;
    }

    .server-member-add {
        grid-template-columns: 1fr;
    }

    .server-role-create {
        grid-template-columns: 1fr;
    }

    .server-link-row {
        grid-template-columns: 1fr;
    }

    .server-member-row {
        grid-template-columns: 1fr;
    }

    .server-asset-card,
    .server-banner-card {
        grid-template-columns: 1fr;
    }

    .server-avatar-preview,
    .server-banner-preview {
        width: 100%;
    }

    .settings-theme-grid {
        grid-template-columns: 1fr;
    }

    .avatar-editor {
        grid-template-columns: 1fr;
        justify-items: start;
    }

    .chat-hdr.server-mode {
        flex-wrap: wrap;
    }

    .chat-hdr.server-mode .server-channel-list {
        margin-left: 0;
        max-width: 100%;
        width: 100%;
    }

    .settings-control-row {
        grid-template-columns: 1fr;
        gap: 8px;
    }

    .settings-value {
        text-align: left;
    }
}

.empty-state,
.contacts-loading {
    display: grid;
    place-items: center;
    min-height: 100%;
    color: var(--text3);
    text-align: center;
    gap: 4px;
    animation: fade-up .28s cubic-bezier(.2,.8,.2,1) both;
}

.empty-ttl {
    color: var(--text);
    font-weight: 900;
}

.empty-sub {
    color: var(--text2);
    font-size: 12px;
}

.sk {
    position: relative;
    overflow: hidden;
    border-radius: 8px;
    background: rgba(255,255,255,.06);
}

.sk::after {
    content: "";
    position: absolute;
    inset: 0;
    transform: translateX(-100%);
    background: linear-gradient(90deg, transparent, rgba(255,255,255,.09), transparent);
    animation: shimmer 1.8s linear 1;
    animation-fill-mode: both;
}

.sk-contact {
    width: calc(100% - 20px);
    height: 50px;
    margin: 8px 10px;
}

.sk-bubble {
    height: 38px;
    margin: 10px 0;
}

.sk-w1 { width: 34%; }
.sk-w2 { width: 52%; }
.sk-w3 { width: 66%; }
.sk-self { margin-left: auto; }

.auth-overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(4, 6, 10, .76);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition:
        opacity .24s ease,
        visibility 0s linear .24s;
}

.auth-overlay.visible {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transition:
        opacity .24s ease,
        visibility 0s linear 0s;
}

.auth-card {
    width: min(460px, 100%);
    padding: 28px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 24px;
    background:
        radial-gradient(circle at top left, rgba(var(--accent-rgb),.1), transparent 28%),
        linear-gradient(180deg, rgba(26,28,32,.96), rgba(12,14,18,.97));
    box-shadow: 0 30px 90px rgba(0,0,0,.52), 0 0 0 1px rgba(var(--accent-rgb),.06);
    transform: translateY(18px) scale(.98);
    opacity: 0;
    transition:
        transform .36s cubic-bezier(.2,.8,.2,1),
        opacity .24s ease,
        box-shadow .24s ease;
    position: relative;
    overflow: hidden;
}

.auth-card::before {
    content: "";
    position: absolute;
    inset: 0;
    background:
        radial-gradient(circle at top right, rgba(var(--accent-rgb),.14), transparent 32%),
        radial-gradient(circle at bottom left, rgba(255,255,255,.05), transparent 26%);
    pointer-events: none;
    opacity: .8;
}

.auth-overlay.visible .auth-card {
    transform: translateY(0) scale(1);
    opacity: 1;
    animation: auth-pop .42s cubic-bezier(.2,.9,.18,1) both;
}

.auth-brand {
    color: var(--lime);
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .18em;
    text-transform: uppercase;
}

.auth-card h1 {
    margin: 10px 0 8px;
    font-size: 28px;
    line-height: 1.1;
    position: relative;
    z-index: 1;
}

.auth-card p {
    margin: 0 0 20px;
    color: var(--text2);
    line-height: 1.5;
    position: relative;
    z-index: 1;
}

.auth-vault-sync {
    margin-top: -10px;
    margin-bottom: 16px;
    color: var(--lime);
    font-size: 12px;
    font-weight: 700;
    line-height: 1.4;
}

.auth-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    position: relative;
    z-index: 1;
}

.auth-input {
    width: 100%;
    height: 44px;
    padding: 0 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    outline: none;
    background: rgba(255,255,255,.03);
    color: var(--text);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
    transition:
        border-color .2s ease,
        box-shadow .2s ease,
        transform .2s ease,
        background .2s ease;
}

.auth-input:focus {
    border-color: var(--lime);
    box-shadow: 0 0 0 3px var(--lime-dim);
    background: rgba(255,255,255,.06);
}

.auth-input--compact {
    flex: 1 1 auto;
    min-width: 0;
}

.auth-actions {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
}

.auth-network {
    display: grid;
    gap: 10px;
    padding: 14px;
    border: 1px solid rgba(255,255,255,.06);
    border-radius: 16px;
    background: rgba(255,255,255,.02);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
}

.auth-network-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
}

.auth-network-title {
    color: var(--text);
    font-size: 12px;
    font-weight: 900;
    letter-spacing: .08em;
    text-transform: uppercase;
}

.auth-network-note {
    color: var(--text2);
    font-size: 11px;
    font-weight: 700;
}

.auth-network-row {
    display: flex;
    gap: 10px;
    align-items: center;
}

.auth-network-help {
    margin: 0;
    color: var(--text2);
    font-size: 12px;
    line-height: 1.45;
}

.auth-btn {
    min-height: 40px;
    border-radius: 12px;
    border: 1px solid transparent;
    cursor: pointer;
    font-weight: 800;
    transition:
        transform .2s ease,
        box-shadow .2s ease,
        background .2s ease,
        border-color .2s ease,
        opacity .2s ease;
    position: relative;
    z-index: 1;
}

.auth-btn:hover {
    box-shadow: 0 0 0 2px rgba(0,0,0,.16);
}

.auth-btn:active {
    transform: translateY(1px) scale(.99);
}

.auth-btn.primary {
    background: var(--lime);
    color: #050505;
    box-shadow: 0 14px 28px rgba(var(--accent-rgb),.2);
}

.auth-btn--ghost {
    min-width: 108px;
    border: 1px solid rgba(var(--accent-rgb), .16);
    background: rgba(255,255,255,.04);
    color: var(--text);
}

.auth-btn.secondary {
    border: 1px solid var(--border);
    background: rgba(255,255,255,.04);
    color: var(--text);
}

.auth-footer {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
}

.auth-link {
    min-height: 28px;
    padding: 0;
    background: none;
    color: var(--lime);
    cursor: pointer;
    font-weight: 700;
    transition: transform .2s ease, opacity .2s ease;
}

.auth-link:hover {
    opacity: .92;
}

.auth-error {
    min-height: 18px;
    color: var(--red);
    font-size: 12px;
    position: relative;
    z-index: 1;
}

.auth-overlay.visible .auth-form > * {
    animation: auth-field-in .42s cubic-bezier(.2,.8,.2,1) both;
}

.auth-overlay.visible .auth-form > *:nth-child(1) { animation-delay: .05s; }
.auth-overlay.visible .auth-form > *:nth-child(2) { animation-delay: .09s; }
.auth-overlay.visible .auth-form > *:nth-child(3) { animation-delay: .13s; }
.auth-overlay.visible .auth-form > *:nth-child(4) { animation-delay: .17s; }
.auth-overlay.visible .auth-form > *:nth-child(5) { animation-delay: .21s; }
.auth-overlay.visible .auth-form > *:nth-child(6) { animation-delay: .25s; }
.auth-overlay.visible .auth-form > *:nth-child(7) { animation-delay: .29s; }

.contacts .contact:nth-child(1),
.msgs .msg:nth-child(1),
.settings-shell > .settings-card:nth-child(1),
.settings-theme-grid .btn-theme:nth-child(1),
.draft-attachments .draft-att:nth-child(1) { animation-delay: .02s; }

.contacts .contact:nth-child(2),
.msgs .msg:nth-child(2),
.settings-shell > .settings-card:nth-child(2),
.settings-theme-grid .btn-theme:nth-child(2),
.draft-attachments .draft-att:nth-child(2) { animation-delay: .05s; }

.contacts .contact:nth-child(3),
.msgs .msg:nth-child(3),
.settings-shell > .settings-card:nth-child(3),
.settings-theme-grid .btn-theme:nth-child(3),
.draft-attachments .draft-att:nth-child(3) { animation-delay: .08s; }

.contacts .contact:nth-child(4),
.msgs .msg:nth-child(4),
.settings-shell > .settings-card:nth-child(4),
.settings-theme-grid .btn-theme:nth-child(4),
.draft-attachments .draft-att:nth-child(4) { animation-delay: .11s; }

.contacts .contact:nth-child(5),
.msgs .msg:nth-child(5),
.settings-shell > .settings-card:nth-child(5),
.settings-theme-grid .btn-theme:nth-child(5),
.draft-attachments .draft-att:nth-child(5) { animation-delay: .14s; }

.contacts .contact:nth-child(6),
.msgs .msg:nth-child(6),
.settings-shell > .settings-card:nth-child(6),
.settings-theme-grid .btn-theme:nth-child(6),
.draft-attachments .draft-att:nth-child(6) { animation-delay: .17s; }

.contacts .contact:nth-child(7),
.msgs .msg:nth-child(7),
.settings-shell > .settings-card:nth-child(7),
.settings-theme-grid .btn-theme:nth-child(7),
.draft-attachments .draft-att:nth-child(7) { animation-delay: .20s; }

.contacts .contact:nth-child(8),
.msgs .msg:nth-child(8),
.settings-shell > .settings-card:nth-child(8),
.settings-theme-grid .btn-theme:nth-child(8),
.draft-attachments .draft-att:nth-child(8) { animation-delay: .23s; }

.contacts .contact {
    animation-delay: 0s;
}

@keyframes shimmer {
    to {
        transform: translateX(100%);
    }
}

@keyframes view-enter {
    from {
        opacity: 0;
        transform: translateY(6px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@keyframes row-fade {
    from {
        opacity: 0;
        transform: translateY(4px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@keyframes contact-in {
    from {
        opacity: 0;
        transform: translateX(-4px);
    }
    to {
        opacity: 1;
        transform: translateX(0);
    }
}

@keyframes contact-active {
    0% {
        transform: scale(.995);
    }
    100% {
        transform: scale(1);
    }
}

@keyframes avatar-pulse {
    0% {
        box-shadow:
            0 0 0 1px rgba(var(--accent-rgb), .10),
            0 0 0 0 rgba(var(--accent-rgb), .18);
    }
    100% {
        box-shadow:
            0 0 0 1px rgba(var(--accent-rgb), .18),
            0 0 0 4px rgba(var(--accent-rgb), .08);
    }
}

@keyframes badge-pop {
    0% {
        opacity: 0;
        transform: scale(.88);
    }
    100% {
        opacity: 1;
        transform: scale(1);
    }
}

@keyframes card-rise {
    from {
        opacity: 0;
        transform: translateY(8px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@keyframes chip-pop {
    from {
        opacity: 0;
        transform: translateY(4px) scale(.98);
    }
    to {
        opacity: 1;
        transform: translateY(0) scale(1);
    }
}

@keyframes segment-icon-pop {
    0% {
        transform: translateY(0) scale(.92);
    }
    58% {
        transform: translateY(-1px) scale(1.14);
    }
    100% {
        transform: translateY(0) scale(1);
    }
}

@keyframes msg-in {
    from {
        opacity: 0;
        transform: translateY(8px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@keyframes bubble-pop {
    from {
        opacity: 0;
        transform: scale(.98);
    }
    to {
        opacity: 1;
        transform: scale(1);
    }
}

@keyframes fade-up {
    from {
        opacity: 0;
        transform: translateY(6px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@keyframes auth-pop {
    0% {
        transform: translateY(22px) scale(.96);
        filter: blur(2px);
    }
    70% {
        transform: translateY(-2px) scale(1.01);
        filter: blur(0);
    }
    100% {
        transform: translateY(0) scale(1);
        filter: blur(0);
    }
}

@keyframes auth-field-in {
    from {
        opacity: 0;
        transform: translateY(10px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@keyframes suggest-drop {
    from {
        opacity: 0;
        transform: translateY(-6px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@media (prefers-reduced-motion: reduce) {
    .auth-overlay,
    .auth-card,
    .auth-input,
    .auth-btn,
    .auth-link,
    .contacts-suggest,
    .contact-suggest-item,
    .view.active,
    .contact,
    .msg,
    .bubble,
    .settings-card,
    .settings-theme-grid .btn-theme,
    .hub-segment-indicator,
    .hub-segment-btn,
    .hub-segment-btn svg,
    .draft-att,
    .badge,
    .date-sep span,
    .empty-state,
    .contacts-loading {
        transition: none !important;
    }

    .auth-overlay.visible .auth-card,
    .auth-overlay.visible .auth-form > *,
    .contacts-suggest,
    .view.active,
    .contact,
    .msg,
    .bubble,
    .settings-card,
    .settings-theme-grid .btn-theme,
    .hub-segment-btn.active svg,
    .draft-att,
    .badge,
    .date-sep span,
    .empty-state,
    .contacts-loading {
        animation: none !important;
    }
}

@media (max-width: 760px) {
    .titlebar {
        grid-template-columns: 1fr auto;
    }

    .tb-l {
        display: none;
    }

    .tb-c {
        text-align: left;
    }

    .body {
        grid-template-columns: 96px 1fr;
    }

    .voice-meter-grid,
    .voice-health-grid {
        grid-template-columns: 1fr;
    }

    .sidebar-head,
    .search-wrap,
    .nav-label,
    .contact-info,
    .me > div,
    .badge,
    .contact-remove {
        display: none;
    }

    .server-channel {
        min-height: 32px;
        padding: 0 10px;
    }

    .server-channel-name {
        font-size: 10px;
    }

    .contact {
        grid-template-columns: 38px;
        justify-content: center;
    }

    .bwrap {
        max-width: 86%;
    }

    .draft-att {
        width: calc(50% - 5px);
    }
}

@media (max-width: 760px) {
    .titlebar {
        grid-template-columns: 44px 1fr auto;
        gap: 8px;
        padding: 0 10px;
    }

    .tb-l {
        display: flex;
    }

    .mobile-menu-btn {
        display: inline-flex;
    }

    .tb-c {
        text-align: left;
        font-size: 11px;
    }

    .tb-brand {
        display: inline-block;
        max-width: 42vw;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .tb-chat {
        display: inline-block;
        max-width: 50vw;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: bottom;
    }

    .tb-r {
        justify-content: flex-end;
    }

    .body {
        grid-template-columns: 1fr;
        gap: 0;
        padding: 12px 12px calc(152px + env(safe-area-inset-bottom, 0px));
    }

    .sidebar {
        position: fixed;
        top: 52px;
        left: 12px;
        bottom: calc(12px + 82px + env(safe-area-inset-bottom, 0px));
        z-index: 20;
        width: min(86vw, 360px);
        transform: translateX(calc(-100% - 18px));
        transition: transform .24s cubic-bezier(.2,.8,.2,1), box-shadow .24s ease;
        will-change: transform;
    }

    body.mobile-sidebar-open .sidebar {
        transform: translateX(0);
        box-shadow: 0 18px 48px rgba(0,0,0,.32), inset 0 1px 0 rgba(255,255,255,.02);
    }

    .main {
        width: 100%;
        min-height: calc(100vh - 76px);
        border-radius: 20px;
    }

    .mobile-backdrop {
        display: block;
    }

    .mobile-dock {
        display: flex;
    }

    #viewChat,
    #viewSettings {
        padding-left: 12px;
        padding-right: 12px;
    }

    #viewChat {
        padding-top: 12px;
        padding-bottom: 14px;
        gap: 14px;
    }

    #viewChat .chat-hdr {
        padding: 12px 14px;
        border-radius: 18px 18px 0 0;
    }

    #viewChat .voice-panel {
        padding: 0 14px 0;
    }

    #viewChat .msgs {
        padding: 14px 12px 208px;
        scroll-padding-bottom: 208px;
    }

    #viewChat .input-area {
        left: 12px;
        right: 12px;
        bottom: 14px;
        min-height: auto;
        margin: 0;
        padding: 12px 12px 24px;
        border-radius: 0 0 18px 18px;
    }

    .input-bar {
        width: 100%;
        margin: 0;
    }

    #viewChat .input-area::before {
        left: 12px;
        right: 12px;
    }

    #viewSettings {
        grid-template-rows: auto 1fr;
        padding-top: 12px;
        padding-bottom: 14px;
    }

    .settings-topbar {
        padding: 14px;
        border-radius: 18px 18px 0 0;
    }

    .settings-body {
        padding: 12px 12px 0;
    }

    .settings-shell {
        gap: 12px;
    }

    .settings-card {
        border-radius: 18px;
    }

    .sidebar-head {
        display: flex;
    }

    .sidebar-brand-stack {
        width: 100%;
    }

    .search-wrap {
        width: calc(100% - 24px);
        align-self: stretch;
        display: flex;
        padding-top: 10px;
    }

    .me-ava {
        font-size: 15px;
        line-height: 1;
    }

    .nav-label {
        display: block;
    }

    .contacts {
        padding: 6px 0 10px;
    }

    .contact-info,
    .me > div,
    .badge,
    .contact-remove {
        display: block;
    }

    .me {
        padding: 14px 16px;
    }

    .contact {
        grid-template-columns: 40px minmax(0, 1fr) auto auto;
        align-items: center;
        gap: 10px;
    }

    .contact-info {
        display: block;
        min-width: 0;
    }

    .contact-remove {
        width: 30px;
        height: 30px;
        border-radius: 10px;
        font-size: 18px;
        display: inline-grid;
        place-items: center;
    }

    .badge {
        min-width: 28px;
        height: 20px;
        padding: 0 6px;
        justify-self: end;
    }

    .server-item {
        gap: 10px;
    }

    .server-meta {
        min-width: 0;
    }

    .server-channel-list {
        padding-bottom: 22px;
    }

    /* ── Touch ergonomics ─────────────────────────────────────── */
    /* Remove the 300ms tap delay + the grey/blue tap flash, and the
       iOS long-press text callout on interactive controls. */
    button, a, [role="button"], .contact, .server-item, .server-channel,
    .mobile-dock-btn, .hub-segment-btn, .settings-input, .search-input {
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
    }
    button, a, [role="button"], .mobile-dock-btn, .hub-segment-btn {
        -webkit-touch-callout: none;
    }

    /* Momentum scrolling; keep overscroll from bouncing the whole page. */
    .contacts, .msgs, .settings-body, .sidebar, .server-channel-list,
    .server-modal-content, .color-picker-body {
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
    }

    /* Never let the page scroll sideways on a phone. */
    html, body {
        overflow-x: hidden;
    }
    img, video {
        max-width: 100%;
    }

    /* iOS zooms the layout when a focused field renders below 16px.
       Force 16px on every text field so focusing an input never zooms. */
    input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="color"]),
    textarea, select {
        font-size: 16px;
    }

    /* Comfortable touch targets (~44px, per Apple HIG / Material). */
    .contact-remove {
        width: 36px;
        height: 36px;
    }
    .settings-input, .search-input {
        min-height: 44px;
    }

    /* Stack the two-column modals so nothing squeezes off-screen. */
    .server-modal-shell {
        grid-template-columns: 1fr;
    }
    .color-picker {
        grid-template-columns: 1fr;
    }
}

/* ── Small phones ─────────────────────────────────────────────── */
@media (max-width: 400px) {
    .mobile-dock {
        gap: 2px;
        padding: 5px;
    }
    .mobile-dock-btn {
        min-height: 44px;
        padding: 5px 2px;
        border-radius: 18px;
    }
    .mobile-dock-btn svg {
        width: 21px;
        height: 21px;
    }
    .mobile-dock-label {
        font-size: 9px;
        letter-spacing: 0;
    }
    .body {
        padding-left: 8px;
        padding-right: 8px;
    }
    #viewChat,
    #viewSettings {
        padding-left: 8px;
        padding-right: 8px;
    }
}

/* ─── Flat Theme — original look, gradients & glows removed ─── */

/* Lift the near-black base a couple of steps */
body[data-experimental-design="on"] {
    --bg: #0c0e12;
    --sidebar: #0c0e12;
}

/* App background — solid, no accent bloom, no grid overlay */
body[data-experimental-design="on"] .app {
    background: var(--bg);
}
body[data-experimental-design="on"] .app::before {
    display: none !important;
}

/* Titlebar */
body[data-experimental-design="on"] .titlebar {
    background: rgba(255, 255, 255, 0.03);
}

/* Sidebar */
body[data-experimental-design="on"] .sidebar {
    background: var(--sidebar);
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
}

/* Segment nav + indicator */
body[data-experimental-design="on"] .hub-segment-nav {
    background: rgba(0, 0, 0, 0.18);
    box-shadow: none;
}
body[data-experimental-design="on"] .hub-segment-indicator {
    background: rgb(var(--accent-rgb));
    box-shadow: none;
}

/* Search input */
body[data-experimental-design="on"] .search-input {
    background: rgba(255, 255, 255, 0.04);
    box-shadow: none;
}

/* Lime/accent solid fills (were gradients) */
body[data-experimental-design="on"] .mode-btn.active,
body[data-experimental-design="on"] .contact-add-btn,
body[data-experimental-design="on"] .server-channel.active,
body[data-experimental-design="on"] .voice-btn,
body[data-experimental-design="on"] .voice-meter-fill,
body[data-experimental-design="on"] .server-avatar-preview,
body[data-experimental-design="on"] .server-banner-preview,
body[data-experimental-design="on"] .hub-orb {
    background: rgb(var(--accent-rgb));
    box-shadow: none;
}
body[data-experimental-design="on"] .voice-btn.danger {
    background: rgb(255, 77, 109);
}

/* Main panel */
body[data-experimental-design="on"] .main {
    background: var(--bg);
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
}

/* Hub */
body[data-experimental-design="on"] #viewHub {
    background: rgba(0, 0, 0, 0.16);
}
body[data-experimental-design="on"] .hub-hero,
body[data-experimental-design="on"] .hub-card {
    background: rgba(255, 255, 255, 0.035);
    box-shadow: none;
}
body[data-experimental-design="on"] .hub-card:hover {
    box-shadow: none;
}
body[data-experimental-design="on"] .hub-components {
    background: rgba(255, 255, 255, 0.025);
    box-shadow: none;
}

/* Message bubbles — flat */
body[data-experimental-design="on"] .bubble {
    background: rgba(255, 255, 255, 0.06);
    box-shadow: none;
}
body[data-experimental-design="on"] .out .bubble {
    background: rgb(var(--accent-rgb));
    border: 1px solid rgb(var(--accent-rgb));
    box-shadow: none;
}
body[data-experimental-design="on"] .msg.group-start::before,
body[data-experimental-design="on"] .msg.out.group-start::before {
    background: none;
}

/* Input bar */
body[data-experimental-design="on"] .input-bar {
    background: rgba(8, 10, 13, 0.9);
    box-shadow: none;
}

/* Settings cards */
body[data-experimental-design="on"] .settings-card {
    background: rgba(255, 255, 255, 0.02);
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
}
body[data-experimental-design="on"] .settings-card::before {
    display: none;
}

/* Server modals & cards — flat */
body[data-experimental-design="on"] .server-modal {
    background: rgb(16, 18, 22);
    box-shadow: none;
}
body[data-experimental-design="on"] .server-modal::before,
body[data-experimental-design="on"] .server-modal-card::before {
    display: none;
}
body[data-experimental-design="on"] .server-modal-sidebar,
body[data-experimental-design="on"] .server-modal-card,
body[data-experimental-design="on"] .server-asset-card,
body[data-experimental-design="on"] .server-link-card,
body[data-experimental-design="on"] .server-channel-card,
body[data-experimental-design="on"] .server-role-card,
body[data-experimental-design="on"] .server-channel-create,
body[data-experimental-design="on"] .server-role-create {
    background: rgba(255, 255, 255, 0.025);
    box-shadow: none;
}

/* Recent accounts */
body[data-experimental-design="on"] .recent-account-row {
    background: rgba(255, 255, 255, 0.035);
    box-shadow: none;
}
body[data-experimental-design="on"] .recent-account-row.is-active {
    background: rgba(255, 255, 255, 0.05);
    box-shadow: none;
}

/* Auth */
body[data-experimental-design="on"] .auth-card {
    background: rgb(18, 20, 24);
    box-shadow: none;
}
body[data-experimental-design="on"] .auth-card::before {
    display: none;
}
body[data-experimental-design="on"] .auth-btn.primary {
    box-shadow: none;
}

/* Misc flats */
body[data-experimental-design="on"] .btn-flat {
    background: rgba(255, 255, 255, 0.05);
}
body[data-experimental-design="on"] .file-chip {
    background: rgba(255, 255, 255, 0.06);
    box-shadow: none;
}

/* Kill remaining accent glows (box-shadow / drop-shadow) */
body[data-experimental-design="on"] .mobile-dock-btn.active,
body[data-experimental-design="on"] .mode-btn.active,
body[data-experimental-design="on"] .contact-add-btn,
body[data-experimental-design="on"] .contact-add-btn:hover,
body[data-experimental-design="on"] .contact.active,
body[data-experimental-design="on"] .server-item.active,
body[data-experimental-design="on"] .btn-flat:hover,
body[data-experimental-design="on"] .send-btn,
body[data-experimental-design="on"] .send-btn:hover,
body[data-experimental-design="on"] .voice-room-card,
body[data-experimental-design="on"] .voice-health-card {
    box-shadow: none;
}
body[data-experimental-design="on"] .server-settings-btn .ui-icon-phone,
body[data-experimental-design="on"] .attach-btn .ui-icon-paperclip {
    filter: none;
}

/* Scrollbar — solid */
body[data-experimental-design="on"] ::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.12);
}
body[data-experimental-design="on"] ::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.2);
}

</style>
    <title>ZaliMessenger</title>

    <script>
    // Inject persisted custom CSS overrides from UserDefaults (set by native Swift layer)
    (function() {
        if (window.__ZALI_SAVED_CSS) {
            var s = document.createElement('style');
            s.id = 'zali-custom-style';
            s.textContent = window.__ZALI_SAVED_CSS;
            document.head.appendChild(s);
        }
    })();
    </script>

    <script>
    window.__ZALI_CONFIG = {};
    </script>

    <script>
    window.__ZALI_BRIDGE_PROTOCOL__ = {"version": 1, "messages": {"SEND_MESSAGE": {"fields": ["text", "recipient", "key", "clientId", "attachments"]}, "SET_SESSION": {"fields": ["username", "token", "deviceId"]}, "REFRESH_HISTORY": {"fields": ["key", "peer"]}, "LOAD_SERVER_HISTORY": {"fields": ["serverId", "channelId", "key"]}, "SAVE_STYLE": {"fields": ["css"]}, "SAVE_MESSAGE_CACHE": {"fields": ["cache"]}, "SAVE_PENDING_OUTBOX": {"fields": ["items"]}, "DOWNLOAD_ATTACHMENT": {"fields": ["dataUrl", "filename"]}, "START_DRAG": {"fields": []}, "RESOLVE_TENOR": {"fields": ["url", "requestId"]}, "SET_KEY": {"fields": ["key"]}, "SET_MESSAGE_REACTION": {"fields": ["messageId", "emoji"]}, "NETWORK_CONFIG": {"fields": ["apiBaseUrl", "wsBaseUrl", "iceServers"]}, "VOICE_EVENT": {"fields": ["payload"]}, "AUTH_REQUEST": {"fields": ["mode", "username", "password", "requestId"]}, "API_REQUEST": {"fields": ["method", "path", "headers", "body", "includeDeviceId", "requestId"]}, "ADD_CONTACT_REQUEST": {"fields": ["username", "requestId"]}, "REMOVE_CONTACT_REQUEST": {"fields": ["username", "requestId"]}, "UPLOAD_AVATAR_REQUEST": {"fields": ["dataUrl", "mimeType", "filename", "requestId"]}, "DELETE_AVATAR_REQUEST": {"fields": ["requestId"]}, "LOAD_AVATAR_REQUEST": {"fields": ["username", "requestId"]}, "SHOW_NOTIFICATION": {"fields": ["sender", "text", "attachmentCount", "serverId", "channelId"]}, "PERSIST_DEVICE_IDENTITY": {"fields": ["username", "identity"]}}};
    </script>
</head>
<body>
    <div class="app">

        <!-- TITLE BAR -->
        <header class="titlebar" id="titlebar">
            <div class="tb-l">
                <button class="mobile-menu-btn" id="mobileMenuBtn" type="button" aria-label="Открыть меню" aria-expanded="false" onclick="document.body.classList.toggle('mobile-sidebar-open'); var b=document.getElementById('mobileBackdrop'); if (b) b.hidden = !document.body.classList.contains('mobile-sidebar-open'); this.setAttribute('aria-expanded', document.body.classList.contains('mobile-sidebar-open') ? 'true' : 'false')">☰</button>
            </div>
            <div class="tb-c">
                <span class="tb-brand">ZaliMessenger</span>
                <span class="tb-sep">/</span>
                <span class="tb-chat" id="tbChat">Загрузка...</span>
            </div>
            <div class="tb-r">
                <div class="ws-pill" id="wsPill">
                    <span class="ws-dot" id="wsDot"></span>
                    <span id="wsLabel">Подключение...</span>
                </div>
            </div>
        </header>

        <button class="mobile-backdrop" id="mobileBackdrop" type="button" aria-label="Закрыть меню" hidden onclick="document.body.classList.remove('mobile-sidebar-open'); this.hidden = true; var m=document.getElementById('mobileMenuBtn'); if (m) m.setAttribute('aria-expanded', 'false')"></button>

        <div class="body">

            <!-- SIDEBAR -->
            <nav class="sidebar">
                <div class="sidebar-head">
                    <div class="sidebar-brand-stack">
                        <div class="brand">ZALI <em>MSG</em></div>
                        <div class="hub-segment-nav" id="hubSegmentNav" aria-label="Разделы приложения"></div>
                    </div>
                    <div class="mode-switch" role="tablist" aria-label="Выбор раздела">
                        <button class="mode-btn" id="modeDmBtn" type="button" aria-pressed="true">ЛС</button>
                        <button class="mode-btn" id="modeServersBtn" type="button" aria-pressed="false">Сервера</button>
                    </div>
                </div>
                <div class="search-wrap">
                    <div class="search-box">
                        <span class="search-icon" aria-hidden="true"></span>
                        <input id="searchInput" class="search-input" placeholder="Поиск..." autocomplete="off">
                    </div>
                    <button class="contact-add-btn" id="contactAddBtn" type="button" title="Добавить контакт">+</button>
                </div>
                <div class="contact-status" id="contactStatus" aria-live="polite"></div>
                <div class="contacts-suggest-wrap" id="contactSuggestionsWrap" hidden>
                    <div class="contacts-suggest" id="contactSuggestions" hidden></div>
                </div>
                <div class="nav-label">Диалоги</div>
                <div class="contacts" id="contacts">
                    <div class="contacts-loading">
                        <div class="sk sk-contact"></div>
                        <div class="sk sk-contact"></div>
                        <div class="sk sk-contact"></div>
                    </div>
                </div>
                <div class="me">
                    <div class="ava me-ava" id="meAva">Z</div>
                    <div class="me-info">
                        <div class="me-name" id="meName">Не вошли</div>
                        <div class="me-sub" id="meSub"><span class="online-dot"></span> В сети</div>
                    </div>
                    <button class="settings-btn" id="settingsBtn" type="button" title="Настройки" aria-label="Настройки">
                        <svg class="ui-icon ui-icon-gear" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
                            <path d="M10.4 3.25h3.2l.55 2.32c.54.2 1.05.5 1.5.87l2.27-.72 1.6 2.76-1.72 1.62c.05.3.08.6.08.9s-.03.6-.08.9l1.72 1.62-1.6 2.76-2.27-.72c-.45.37-.96.67-1.5.87l-.55 2.32h-3.2l-.55-2.32a5.78 5.78 0 0 1-1.5-.87l-2.27.72-1.6-2.76L6.2 11.9a5.6 5.6 0 0 1 0-1.8L4.48 8.48l1.6-2.76 2.27.72c.45-.37.96-.67 1.5-.87l.55-2.32Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                            <circle cx="12" cy="11" r="2.65" stroke="currentColor" stroke-width="1.8"/>
                        </svg>
                    </button>
                </div>
            </nav>

            <!-- CONTENT -->
            <div class="main">

                <!-- CHAT VIEW -->
                <div id="viewChat" class="view active">
                    <div class="chat-hdr" id="chatHdr">
                        <div class="chat-hdr-ava" id="chatHdrAva">A</div>
                        <div class="chat-hdr-info">
                            <div class="chat-hdr-name" id="chatHdrName">Alice</div>
                            <div class="chat-hdr-sub" id="chatHdrSub">Личное сообщение</div>
                        </div>
                        <div class="chat-hdr-actions">
                            <button class="server-settings-btn chat-call-btn" id="chatCallBtn" type="button" title="Позвонить" aria-label="Позвонить" hidden>
                                <svg class="ui-icon ui-icon-phone" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
                                    <path d="M6.15 4.4c-.92.16-1.62.9-1.72 1.83-.67 6.32 6.98 13.97 13.3 13.3.93-.1 1.67-.8 1.83-1.72l.36-2.08a1.18 1.18 0 0 0-.76-1.32l-3.18-1.16a1.22 1.22 0 0 0-1.27.3l-1.1 1.06a10.4 10.4 0 0 1-4.22-4.22l1.06-1.1c.34-.35.45-.86.3-1.27L9.59 4.84a1.18 1.18 0 0 0-1.32-.76l-2.12.32Z" stroke="currentColor" stroke-width="2.25" stroke-linejoin="round"/>
                                    <path d="M14.85 5.3c1.86.55 3.3 1.99 3.85 3.85" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                                </svg>
                            </button>
                            <button class="server-settings-btn" id="serverSettingsBtn" type="button" title="Настройки сервера" aria-label="Настройки сервера" hidden>
                                <svg class="ui-icon ui-icon-gear" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
                                    <path d="M10.4 3.25h3.2l.55 2.32c.54.2 1.05.5 1.5.87l2.27-.72 1.6 2.76-1.72 1.62c.05.3.08.6.08.9s-.03.6-.08.9l1.72 1.62-1.6 2.76-2.27-.72c-.45.37-.96.67-1.5.87l-.55 2.32h-3.2l-.55-2.32a5.78 5.78 0 0 1-1.5-.87l-2.27.72-1.6-2.76L6.2 11.9a5.6 5.6 0 0 1 0-1.8L4.48 8.48l1.6-2.76 2.27.72c.45-.37.96-.67 1.5-.87l.55-2.32Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                                    <circle cx="12" cy="11" r="2.65" stroke="currentColor" stroke-width="1.8"/>
                                </svg>
                            </button>
                        </div>
                        <div class="server-channel-list" id="serverChannelList" hidden></div>
                    </div>

                    <div class="voice-panel" id="voicePanel" hidden></div>

                    <div class="msgs" id="msgs"></div>

                    <div class="input-area">
                        <div class="draft-attachments" id="draftAttachments"></div>
                        <div class="input-bar" id="inputBar">
                            <button class="attach-btn" id="attachBtn" type="button" title="Прикрепить картинку или GIF" aria-label="Прикрепить картинку или GIF">
                                <svg class="ui-icon ui-icon-paperclip" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
                                    <path d="M8.1 12.75 13.72 7.1a3.04 3.04 0 0 1 4.3 4.3l-6.7 6.7a4.95 4.95 0 0 1-7-7l6.66-6.66a6.78 6.78 0 0 1 9.58 9.58l-6.82 6.82" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M8.72 12.78 14.2 7.3" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" opacity=".42"/>
                                </svg>
                            </button>
                            <input id="attachmentInput" type="file" accept="image/*,video/*,.gif,.webp,.png,.jpg,.jpeg,.mp4,.webm" multiple hidden>
                            <textarea id="msgInput" placeholder="Сообщение..." autocomplete="off" maxlength="4000" rows="1"></textarea>
                            <button class="send-btn" id="sendBtn" disabled>
                                <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17">
                                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- HUB VIEW -->
                <div id="viewHub" class="view">
                    <div class="hub-view">
                        <section class="hub-hero">
                            <div>
                                <span class="settings-kicker">Zali Hub</span>
                                <h2>Главная панель Zali Messenger</h2>
                                <p>Новости, уведомления, обновления и быстрый вход в подприложения. Это стартовая точка нового интерфейса.</p>
                            </div>
                            <div class="hub-orb" aria-hidden="true">HUB</div>
                        </section>
                        <div class="hub-grid" id="hubGrid"></div>
                        <section class="hub-components" id="hubComponents"></section>
                    </div>
                </div>

                <!-- SETTINGS VIEW (CUSTOMIZATION, LOGS & CRYPTO) -->
                <div id="viewSettings" class="view">
                    <div class="logs-bar settings-topbar">
                        <div class="settings-topcopy">
                            <span class="settings-kicker">Центр управления</span>
                            <span class="logs-title">Настройки</span>
                            <p class="settings-lead">Кастомизация интерфейса, журнал событий и действия аккаунта в одном месте.</p>
                        </div>
                        <button class="btn-flat" id="closeSettings">Назад</button>
                    </div>
                    <div class="settings-body settings-scroll">
                        <div class="settings-shell">
                            <section class="settings-card settings-hero">
                                <div class="settings-hero-copy">
                                    <span class="settings-kicker">Быстрый обзор</span>
                                    <h2>Настройте внешний вид, проверьте журнал и управляйте параметрами без лишних переходов.</h2>
                                    <p>Меню разделено на понятные блоки, чтобы основные действия были под рукой и не терялись в длинном списке.</p>
                                </div>
                                <div class="settings-chips">
                                    <span class="settings-chip">Styler</span>
                                    <span class="settings-chip">Logs</span>
                                    <span class="settings-chip">Crypto</span>
                                    <span class="settings-chip">Account</span>
                                </div>
                            </section>

                            <section class="settings-card">
                                <div class="settings-card-head">
                                    <div>
                                        <span class="settings-kicker">Profile</span>
                                        <h3 class="settings-card-title">Аватар профиля</h3>
                                    </div>
                                    <span class="settings-card-note" id="avatarTargetLabel">sync</span>
                                </div>
                                <div class="avatar-editor">
                                    <div class="avatar-editor-preview">
                                        <div class="ava avatar-preview" id="avatarPreview">Z</div>
                                    </div>
                                    <div class="avatar-editor-copy">
                                        <p class="settings-help">Загрузите картинку для своего профиля — она сохранится на сервере и будет видна всем вашим собеседникам на других устройствах. После обновления аватар автоматически подтянется в списке контактов, шапке чата и профиле.</p>
                                        <div class="avatar-editor-actions">
                                            <button class="btn-flat avatar-upload-btn" id="avatarUploadBtn" type="button">Загрузить</button>
                                            <button class="btn-flat" id="avatarResetBtn" type="button">Сбросить аватар</button>
                                        </div>
                                    </div>
                                </div>
                            </section>

                            <section class="settings-card">
                                <div class="settings-card-head">
                                    <div>
                                        <span class="settings-kicker">Interface v2</span>
                                        <h3 class="settings-card-title">Новая навигация и Хаб</h3>
                                    </div>
                                    <span class="settings-card-note">experimental</span>
                                </div>
                                <div class="settings-stack">
                                    <label class="server-toggle settings-toggle">
                                        <input id="inputUiV2Enabled" type="checkbox">
                                        <span>
                                            <strong>Включить новый интерфейс</strong>
                                            <small>Скрывает переключатель ЛС/Сервера и показывает сегменты под названием приложения</small>
                                        </span>
                                    </label>
                                    <div class="settings-control-box">
                                        <div class="settings-card-head settings-card-head--tight">
                                            <div>
                                                <span class="settings-kicker">Segments</span>
                                                <h3 class="settings-card-title">Кнопки под названием</h3>
                                            </div>
                                            <span class="settings-card-note" id="hubSegmentsCount">3 / 4</span>
                                        </div>
                                        <div class="hub-segment-settings" id="hubSegmentSettings"></div>
                                        <p class="settings-help">Выберите от 1 до 3 разделов перед Хабом. Последняя кнопка всегда Хаб, поэтому всего будет от 2 до 4 кнопок.</p>
                                    </div>
                                </div>
                            </section>

                            <section class="settings-card">
                                <div class="settings-card-head">
                                    <div>
                                        <span class="settings-kicker">Тема интерфейса</span>
                                        <h3 class="settings-card-title">Плоский режим</h3>
                                    </div>
                                    <span class="settings-card-note">flat</span>
                                </div>
                                <div class="settings-stack">
                                    <label class="server-toggle settings-toggle">
                                        <input id="inputExperimentalDesign" type="checkbox">
                                        <span>
                                            <strong>Включить плоский режим</strong>
                                            <small>Тот же интерфейс, но без градиентов и свечений — матовые поверхности</small>
                                        </span>
                                    </label>
                                </div>
                            </section>

                            <div class="settings-grid">
                                <div class="settings-column">
                                    <section class="settings-card">
                                        <div class="settings-card-head">
                                            <div>
                                                <span class="settings-kicker">Styler</span>
                                                <h3 class="settings-card-title">Цветовая схема</h3>
                                            </div>
                                            <span class="settings-card-note">zali_styler</span>
                                        </div>
                                        <div class="theme-buttons settings-theme-grid">
                                            <button class="btn-theme theme-lime" data-theme="lime" type="button">Lime</button>
                                            <button class="btn-theme theme-cyber" data-theme="cyber" type="button">Cyberpunk</button>
                                            <button class="btn-theme theme-matrix" data-theme="matrix" type="button">Matrix</button>
                                            <button class="btn-theme theme-ocean" data-theme="ocean" type="button">Ocean</button>
                                            <button class="btn-theme theme-mono" data-theme="mono" type="button">Monochrome</button>
                                            <button class="btn-theme theme-ember" data-theme="ember" type="button">Ember</button>
                                            <button class="btn-theme theme-aurora" data-theme="aurora" type="button">Aurora</button>
                                            <button class="btn-theme theme-graphite" data-theme="graphite" type="button">Graphite</button>
                                            <button class="btn-theme theme-rose" data-theme="rose" type="button">Rose</button>
                                            <button class="btn-theme theme-violet" data-theme="violet" type="button">Violet</button>
                                        </div>
                                    </section>

                                </div>

                                <div class="settings-column">
                                    <section class="settings-card settings-card--logs">
                                        <div class="settings-card-head settings-card-head--tight">
                                            <div>
                                                <span class="settings-kicker">Telemetry</span>
                                                <h3 class="settings-card-title">Журнал событий</h3>
                                            </div>
                                            <button class="btn-flat" id="clearLogs" type="button">Очистить</button>
                                        </div>
                                        <div class="log-body settings-log-body" id="logBody"></div>
                                    </section>

                                    <section class="settings-card">
                                        <div class="settings-card-head">
                                            <div>
                                                <span class="settings-kicker">Security</span>
                                                <h3 class="settings-card-title">Ключ шифрования</h3>
                                            </div>
                                            <span class="settings-card-note">zali_crypto</span>
                                        </div>
                                        <div class="settings-stack">
                                            <input type="text" id="inputCryptoKey" class="settings-input" placeholder="Введите общий E2E-ключ">
                                            <p class="settings-help">Текущий ключ: <code id="currentCryptoKeyValue" class="crypto-key-value">не задан</code></p>
                                            <p class="settings-help" id="currentCryptoKeyMeta">Контекст: общий ключ</p>
                                            <p class="settings-help">Измените секретную фразу для E2E-шифрования. Для чтения переписки собеседники должны использовать одинаковый ключ, и он не должен храниться в коде.</p>
                                            <label class="server-toggle settings-toggle">
                                                <input id="inputVaultCloudSyncEnabled" type="checkbox">
                                                <span>
                                                    <strong>Синхронизировать ключи в облако для аккаунта</strong>
                                                    <small>Настройка сохраняется в аккаунте и работает на всех ваших устройствах</small>
                                                </span>
                                            </label>
                                            <div class="settings-card-head settings-card-head--tight" style="margin-top:8px">
                                                <div>
                                                    <strong>Сбросить и перевыпустить ключи</strong>
                                                    <p class="settings-help" style="margin:2px 0 0">Удаляет все ключи переписок локально и на сервере, генерирует новую пару ECDH-ключей устройства и переустанавливает ключи при следующей отправке сообщения.</p>
                                                </div>
                                            </div>
                                            <button class="btn-flat settings-logout" id="resetEncryptionKeysBtn" type="button">Сбросить ключи шифрования</button>
                                            <p class="settings-help" id="resetEncryptionKeysStatus" hidden style="text-align:center;font-weight:600;margin-top:4px"></p>
                                        </div>
                                    </section>

                                    <section class="settings-card settings-card--danger">
                                        <div class="settings-card-head">
                                            <div>
                                                <span class="settings-kicker">Account</span>
                                                <h3 class="settings-card-title">Сеанс</h3>
                                            </div>
                                            <span class="settings-card-note">Безопасно</span>
                                        </div>
                                        <p class="settings-help">Завершите текущий вход, если хотите переключить аккаунт или выйти из гостевого режима.</p>
                                        <div class="recent-accounts" id="recentAccounts"></div>
                                        <button class="btn-flat settings-logout" id="settingsLogoutBtn" type="button">Выйти из аккаунта</button>
                                    </section>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

            </div>
        </div>

        <div class="mobile-dock" id="mobileDock" aria-label="Мобильная навигация">
            <button class="mobile-dock-btn" id="mobileChatsBtn" type="button" onclick="var cv=document.getElementById('viewChat'), sv=document.getElementById('viewSettings'); if (cv) cv.classList.add('active'); if (sv) sv.classList.remove('active'); var t=document.getElementById('tbChat'); if (t) t.textContent='Чаты'; var dm=document.getElementById('modeDmBtn'); if (dm) dm.click(); document.body.classList.add('mobile-sidebar-open'); var b=document.getElementById('mobileBackdrop'); if (b) b.hidden = false; var m=document.getElementById('mobileMenuBtn'); if (m) m.setAttribute('aria-expanded', 'true')"><span class="mobile-dock-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/></svg></span><span class="mobile-dock-label">Чаты</span></button>
            <button class="mobile-dock-btn" id="mobileServersBtn" type="button" onclick="var cv=document.getElementById('viewChat'), sv=document.getElementById('viewSettings'); if (cv) cv.classList.add('active'); if (sv) sv.classList.remove('active'); var t=document.getElementById('tbChat'); if (t) t.textContent='Сервера'; var svBtn=document.getElementById('modeServersBtn'); if (svBtn) svBtn.click(); document.body.classList.add('mobile-sidebar-open'); var b=document.getElementById('mobileBackdrop'); if (b) b.hidden = false; var m=document.getElementById('mobileMenuBtn'); if (m) m.setAttribute('aria-expanded', 'true')"><span class="mobile-dock-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></svg></span><span class="mobile-dock-label">Сервера</span></button>
            <button class="mobile-dock-btn" id="mobileHubBtn" type="button"><span class="mobile-dock-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/></svg></span><span class="mobile-dock-label">Хаб</span></button>
            <button class="mobile-dock-btn" id="mobileSettingsBtn" type="button" onclick="var cv=document.getElementById('viewChat'), sv=document.getElementById('viewSettings'); if (cv) cv.classList.remove('active'); if (sv) sv.classList.add('active'); var t=document.getElementById('tbChat'); if (t) t.textContent='Настройки'; document.body.classList.remove('mobile-sidebar-open'); var b=document.getElementById('mobileBackdrop'); if (b) b.hidden = true; var m=document.getElementById('mobileMenuBtn'); if (m) m.setAttribute('aria-expanded', 'false')"><span class="mobile-dock-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span><span class="mobile-dock-label">Настройки</span></button>
        </div>
    </div>

    <div class="avatar-crop-overlay" id="avatarCropOverlay" hidden>
        <div class="avatar-crop-modal" role="dialog" aria-modal="true" aria-labelledby="avatarCropTitle">
            <div class="avatar-crop-head">
                <h2 id="avatarCropTitle">Обрезка аватара</h2>
                <button class="avatar-crop-close" id="avatarCropCloseBtn" type="button" aria-label="Отмена">×</button>
            </div>
            <div class="avatar-crop-stage-wrap">
                <div class="avatar-crop-stage" id="avatarCropStage">
                    <img class="avatar-crop-img" id="avatarCropImg" alt="Предпросмотр аватара" draggable="false">
                    <div class="avatar-crop-circle-guide" id="avatarCropCircleGuide" aria-hidden="true"></div>
                </div>
            </div>
            <div class="avatar-crop-zoom-row">
                <span class="avatar-crop-zoom-icon" aria-hidden="true">−</span>
                <input type="range" class="avatar-crop-zoom" id="avatarCropZoom" min="0" max="1000" step="1" value="0" aria-label="Масштаб">
                <span class="avatar-crop-zoom-icon avatar-crop-zoom-icon--big" aria-hidden="true">+</span>
            </div>
            <p class="avatar-crop-hint">Перетащите фото, чтобы выбрать область, и настройте масштаб ползунком.</p>
            <div class="avatar-crop-actions">
                <button class="btn-flat" id="avatarCropCancelBtn" type="button">Отмена</button>
                <button class="auth-btn primary" id="avatarCropSaveBtn" type="button">Сохранить</button>
            </div>
        </div>
    </div>

    <div class="server-overlay" id="serverOverlay" hidden>
        <div class="server-modal" id="serverModal" role="dialog" aria-modal="true" aria-labelledby="serverModalTitle">
            <div class="server-modal-head">
                <div class="server-modal-headcopy">
                    <span class="server-modal-kicker" id="serverModalKicker">Создание сервера</span>
                    <h2 id="serverModalTitle">Создать сервер</h2>
                    <p id="serverModalHint">Настройте имя, оформление и права доступа.</p>
                </div>
                <button class="server-modal-close" id="serverModalClose" type="button" aria-label="Закрыть">×</button>
            </div>

            <div class="server-modal-shell">
                <aside class="server-modal-sidebar">
                    <div class="server-modal-sidebar-head">
                        <span class="server-modal-sidebar-kicker">Навигация</span>
                        <div class="server-modal-sidebar-title" id="serverModalSidebarTitle">Настройки сервера</div>
                        <div class="server-modal-sidebar-sub" id="serverModalSidebarHint">Выберите раздел слева, чтобы быстро перейти к нужным настройкам.</div>
                    </div>
                    <nav class="server-modal-nav" id="serverModalNav" aria-label="Разделы настроек">
                        <button class="server-modal-nav-btn" type="button" data-server-modal-section="overview">
                            <span class="server-modal-nav-label">Обзор</span>
                            <span class="server-modal-nav-desc">Имя, внешний вид и ссылка</span>
                        </button>
                        <button class="server-modal-nav-btn" type="button" data-server-modal-section="channels">
                            <span class="server-modal-nav-label">Каналы</span>
                            <span class="server-modal-nav-desc">Создание и настройка каналов</span>
                        </button>
                        <button class="server-modal-nav-btn" type="button" data-server-modal-section="roles">
                            <span class="server-modal-nav-label">Роли</span>
                            <span class="server-modal-nav-desc">Права и оформление ролей</span>
                        </button>
                        <button class="server-modal-nav-btn" type="button" data-server-modal-section="members">
                            <span class="server-modal-nav-label">Участники</span>
                            <span class="server-modal-nav-desc">Управление участниками сервера</span>
                        </button>
                        <button class="server-modal-nav-btn" type="button" data-server-modal-section="discover">
                            <span class="server-modal-nav-label">Публичные серверы</span>
                            <span class="server-modal-nav-desc">Поиск и вход в сообщества</span>
                        </button>
                    </nav>
                </aside>

                <div class="server-modal-body">
                    <div class="server-modal-grid">
                        <section class="server-modal-section" data-server-modal-panel="overview" id="serverOverviewPanel">
                            <section class="server-modal-card" id="serverBasicsCard">
                                <div class="settings-card-head settings-card-head--tight">
                                    <div>
                                        <span class="settings-kicker">Basics</span>
                                        <h3 class="settings-card-title">Параметры сервера</h3>
                                    </div>
                                    <span class="settings-card-note" id="serverModalModeNote">create</span>
                                </div>
                                <div class="server-form">
                                    <input id="serverNameInput" class="settings-input" type="text" maxlength="64" placeholder="Название сервера">
                                    <input id="serverIconInput" class="settings-input" type="text" maxlength="8" placeholder="Иконка, символ или эмодзи">
                                    <div class="color-picker color-picker--compact color-picker--collapsible is-collapsed" data-color-picker-key="server-basics">
                                        <div class="color-picker-head">
                                            <div class="color-picker-summary">
                                                <span class="color-picker-preview" style="background:#cbff00"></span>
                                                <div class="color-picker-copy">
                                                    <div class="color-picker-title">RGB</div>
                                                    <div class="color-picker-sub">Свернуто по умолчанию</div>
                                                </div>
                                            </div>
                                            <button class="btn-flat color-picker-toggle" id="serverColorToggleBtn" type="button" data-color-picker-toggle="server-basics">Развернуть</button>
                                        </div>
                                        <div class="color-picker-body">
                                            <div class="color-wheel color-wheel--small" id="serverColorWheel" tabindex="0" aria-label="Цвет сервера">
                                                <div class="color-wheel-thumb"></div>
                                                <div class="color-wheel-center">RGB</div>
                                            </div>
                                            <div class="color-picker-side">
                                                <input id="serverColorInput" type="hidden" value="#cbff00">
                                                <input id="serverColorHexInput" class="settings-input color-hex-input" type="text" maxlength="7" value="#cbff00" aria-label="HEX цвет сервера">
                                                <p class="settings-help color-picker-help">Выберите цвет колесом или введите HEX.</p>
                                            </div>
                                        </div>
                                    </div>
                                    <textarea id="serverDescriptionInput" class="settings-textarea" rows="4" maxlength="180" placeholder="Описание сервера"></textarea>
                                    <label class="server-toggle">
                                        <input id="serverPublicInput" type="checkbox" checked>
                                        <span>
                                            <strong>Публичный сервер</strong>
                                            <small>Виден всем пользователям</small>
                                        </span>
                                    </label>
                                </div>
                                <div class="server-assets">
                                    <div class="server-asset-card">
                                        <div class="server-asset-preview server-avatar-preview" id="serverAvatarPreview">S</div>
                                        <div class="server-asset-copy">
                                            <div class="server-asset-title">Аватар сервера</div>
                                            <div class="server-asset-sub">Круглая иконка в списке серверов</div>
                                            <div class="server-asset-actions">
                                                <button class="btn-flat" id="serverAvatarUploadBtn" type="button">Загрузить</button>
                                                <button class="btn-flat" id="serverAvatarRemoveBtn" type="button">Удалить</button>
                                            </div>
                                        </div>
                                    </div>
                                    <div class="server-asset-card server-banner-card">
                                        <div class="server-asset-preview server-banner-preview" id="serverBannerPreview">BAN</div>
                                        <div class="server-asset-copy">
                                            <div class="server-asset-title">Баннер сервера</div>
                                            <div class="server-asset-sub">Широкая шапка для сервера</div>
                                            <div class="server-asset-actions">
                                                <button class="btn-flat" id="serverBannerUploadBtn" type="button">Загрузить</button>
                                                <button class="btn-flat" id="serverBannerRemoveBtn" type="button">Удалить</button>
                                            </div>
                                        </div>
                                    </div>
                                    <div class="server-link-card">
                                        <div class="server-asset-title">Ссылка входа</div>
                                        <div class="server-asset-sub">Сюда можно вставить адрес сервера, по которому будут входить пользователи.</div>
                                        <div class="server-link-row">
                                            <input id="serverJoinLinkInput" class="settings-input" type="text" placeholder="Ссылка на сервер">
                                            <button class="btn-flat" id="serverJoinLinkGenerateBtn" type="button">Сгенерировать</button>
                                            <button class="btn-flat" id="serverJoinLinkCopyBtn" type="button">Копировать</button>
                                        </div>
                                    </div>
                                </div>
                            </section>
                        </section>

                        <section class="server-modal-section" data-server-modal-panel="channels" id="serverChannelsPanel" hidden>
                            <section class="server-modal-card" id="serverChannelsCard">
                                <div class="settings-card-head settings-card-head--tight">
                                    <div>
                                        <span class="settings-kicker">Channels</span>
                                        <h3 class="settings-card-title">Каналы сервера</h3>
                                    </div>
                                    <span class="settings-card-note" id="serverChannelsCount">0</span>
                                </div>
                                <div class="server-channel-create is-collapsed" data-server-channel-create>
                                    <div class="server-channel-create-head">
                                        <div class="server-channel-create-copy">
                                            <div class="server-channel-create-title">Новый канал</div>
                                            <div class="server-channel-create-sub">Нажмите, чтобы открыть форму создания</div>
                                        </div>
                                        <button class="btn-flat server-channel-create-btn" id="serverChannelCreateBtn" type="button">Новый канал</button>
                                    </div>
                                    <div class="server-channel-create-body" data-server-channel-create-body hidden>
                                        <input id="serverChannelNameInput" class="settings-input" type="text" maxlength="64" placeholder="Название канала" autocomplete="off" autocapitalize="none" spellcheck="false" inputmode="text">
                                        <input id="serverChannelTopicInput" class="settings-input" type="text" maxlength="180" placeholder="Тема или описание канала" autocomplete="off" autocapitalize="none" spellcheck="false" inputmode="text">
                                        <div class="server-channel-create-row">
                                            <select id="serverChannelKindInput" class="settings-input">
                                                <option value="text" selected>Текстовый канал</option>
                                                <option value="voice">Голосовой канал</option>
                                            </select>
                                            <button class="auth-btn primary" id="serverChannelCreateSubmitBtn" type="button">Создать канал</button>
                                        </div>
                                    </div>
                                </div>
                                <div class="server-channels-list" id="serverChannelsList"></div>
                            </section>
                        </section>

                        <section class="server-modal-section" data-server-modal-panel="roles" id="serverRolesPanel" hidden>
                            <section class="server-modal-card" id="serverRolesCard">
                                <div class="settings-card-head settings-card-head--tight">
                                    <div>
                                        <span class="settings-kicker">Roles</span>
                                        <h3 class="settings-card-title">Роли сервера</h3>
                                    </div>
                                    <span class="settings-card-note" id="serverRolesCount">0</span>
                                </div>
                                <div class="server-role-create is-collapsed" data-server-role-create>
                                    <div class="server-role-create-head">
                                        <div class="server-role-create-copy">
                                            <div class="server-role-create-title">Новая роль</div>
                                            <div class="server-role-create-sub">Нажмите, чтобы открыть форму создания</div>
                                        </div>
                                        <button class="btn-flat server-role-create-btn" id="serverRoleCreateBtn" type="button">Новая роль</button>
                                    </div>
                                    <div class="server-role-create-body" data-server-role-create-body hidden>
                                        <input id="serverRoleNameInput" class="settings-input" type="text" maxlength="64" placeholder="Название роли" autocomplete="off" autocapitalize="none" spellcheck="false" inputmode="text">
                                        <div class="color-picker color-picker--compact color-picker--collapsible is-collapsed" data-color-picker-key="server-role-create">
                                            <div class="color-picker-head">
                                                <div class="color-picker-summary">
                                                    <span class="color-picker-preview" style="background:#cbff00"></span>
                                                    <div class="color-picker-copy">
                                                        <div class="color-picker-title">RGB</div>
                                                        <div class="color-picker-sub">Свернуто по умолчанию</div>
                                                    </div>
                                                </div>
                                                <button class="btn-flat color-picker-toggle" id="serverRoleColorToggleBtn" type="button" data-color-picker-toggle="server-role-create">Развернуть</button>
                                            </div>
                                            <div class="color-picker-body">
                                                <div class="color-wheel color-wheel--small" id="serverRoleColorWheel" tabindex="0" aria-label="Цвет роли">
                                                    <div class="color-wheel-thumb"></div>
                                                    <div class="color-wheel-center">RGB</div>
                                                </div>
                                                <div class="color-picker-side">
                                                    <input id="serverRoleColorInput" type="hidden" value="#cbff00">
                                                    <input id="serverRoleColorHexInput" class="settings-input color-hex-input" type="text" maxlength="7" value="#cbff00" aria-label="HEX цвет роли">
                                                </div>
                                            </div>
                                        </div>
                                        <div class="server-role-create-perms">
                                            <div class="server-perm-group">
                                                <div class="server-perm-group-title">Доступ</div>
                                                <div class="server-perm-grid server-perm-grid--dense">
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>Чтение каналов</strong><small>Видеть список и историю сообщений</small></span>
                                                        <input id="serverRolePermView" type="checkbox" data-server-role-perm="can_view" checked>
                                                    </label>
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>Отправка сообщений</strong><small>Писать в текстовые каналы</small></span>
                                                        <input id="serverRolePermSend" type="checkbox" data-server-role-perm="can_send" checked>
                                                    </label>
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>Реакции</strong><small>Ставить реакции на сообщения</small></span>
                                                        <input type="checkbox" data-server-role-perm="can_react" checked>
                                                    </label>
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>Файлы</strong><small>Прикреплять изображения и файлы</small></span>
                                                        <input type="checkbox" data-server-role-perm="can_attach" checked>
                                                    </label>
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>Ссылки и медиа</strong><small>Встраивать превью ссылок</small></span>
                                                        <input type="checkbox" data-server-role-perm="can_embed" checked>
                                                    </label>
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>Голосовые каналы</strong><small>Входить и говорить в voice</small></span>
                                                        <input type="checkbox" data-server-role-perm="can_voice" checked>
                                                    </label>
                                                </div>
                                            </div>
                                            <div class="server-perm-group">
                                                <div class="server-perm-group-title">Управление</div>
                                                <div class="server-perm-grid server-perm-grid--dense">
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>Управление сервером</strong><small>Общие админские действия</small></span>
                                                        <input id="serverRolePermManage" type="checkbox" data-server-role-perm="can_manage">
                                                    </label>
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>Каналы</strong><small>Создавать и менять каналы</small></span>
                                                        <input type="checkbox" data-server-role-perm="can_manage_channels">
                                                    </label>
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>Роли</strong><small>Создавать и менять роли</small></span>
                                                        <input type="checkbox" data-server-role-perm="can_manage_roles">
                                                    </label>
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>Приглашения</strong><small>Генерировать инвайты</small></span>
                                                        <input type="checkbox" data-server-role-perm="can_invite" checked>
                                                    </label>
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>Закреплять</strong><small>Закреплять важные сообщения</small></span>
                                                        <input type="checkbox" data-server-role-perm="can_pin">
                                                    </label>
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>@everyone</strong><small>Упоминать всех участников</small></span>
                                                        <input type="checkbox" data-server-role-perm="can_mention">
                                                    </label>
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>Исключать</strong><small>Кикать участников из сервера</small></span>
                                                        <input type="checkbox" data-server-role-perm="can_kick">
                                                    </label>
                                                    <label class="server-perm-row server-perm-row--stacked">
                                                        <span><strong>Бан</strong><small>Блокировать участников</small></span>
                                                        <input type="checkbox" data-server-role-perm="can_ban">
                                                    </label>
                                                </div>
                                            </div>
                                        </div>
                                        <div class="server-role-create-actions">
                                            <button class="auth-btn primary" id="serverRoleCreateSubmitBtn" type="button">Создать роль</button>
                                        </div>
                                    </div>
                                </div>
                                <div class="server-roles-list" id="serverRolesList"></div>
                            </section>
                        </section>

                        <section class="server-modal-section" data-server-modal-panel="members" id="serverMembersPanel" hidden>
                            <section class="server-modal-card" id="serverMembersCard">
                                <div class="settings-card-head settings-card-head--tight">
                                    <div>
                                        <span class="settings-kicker">Members</span>
                                        <h3 class="settings-card-title">Участники и роли</h3>
                                    </div>
                                    <span class="settings-card-note" id="serverMembersCount">0</span>
                                </div>
                                <div class="server-member-add">
                                    <input id="serverMemberInput" class="settings-input" type="text" maxlength="64" placeholder="Логин участника">
                                    <select id="serverMemberRole" class="settings-input"></select>
                                    <button class="btn-flat" id="serverMemberAddBtn" type="button">Добавить</button>
                                </div>
                                <div class="server-members-list" id="serverMembersList"></div>
                            </section>
                        </section>

                        <section class="server-modal-section" data-server-modal-panel="discover" id="serverDiscoverPanel" hidden>
                            <section class="server-modal-card server-discover-card" id="serverDiscoverCard">
                                <div class="settings-card-head settings-card-head--tight">
                                    <div>
                                        <span class="settings-kicker">Public</span>
                                        <h3 class="settings-card-title">Публичные серверы</h3>
                                    </div>
                                    <div class="server-discover-head-actions">
                                        <span class="settings-card-note" id="serverDiscoverCount">0</span>
                                        <button class="btn-flat" id="serverDiscoverRefreshBtn" type="button">Обновить</button>
                                    </div>
                                </div>
                                <div class="server-discover-toolbar">
                                    <input id="serverDiscoverQuery" class="settings-input" type="text" placeholder="Поиск публичных серверов">
                                </div>
                                <div class="server-discover-list" id="serverDiscoverList"></div>
                            </section>
                        </section>
                    </div>
                </div>
            </div>

            <div class="server-modal-error" id="serverModalError"></div>
            <div class="server-modal-actions">
                <button class="btn-flat" id="serverModalCancel" type="button">Отмена</button>
                <button class="btn-flat server-delete-btn" id="serverDeleteBtn" type="button" hidden>Удалить сервер</button>
                <button class="auth-btn primary" id="serverSaveBtn" type="button">Создать</button>
            </div>
        </div>
    </div>

    <div class="auth-overlay visible" id="authOverlay">
        <div class="auth-card">
            <div class="auth-brand">ZaliMessenger</div>
            <h1 id="authTitle">Вход в аккаунт</h1>
            <p id="authHint">Войдите, чтобы синхронизировать сообщения и контакты.</p>
            <p class="auth-vault-sync" id="authVaultSyncNote">Ключи переписки подгрузятся из облака при входе.</p>
            <form class="auth-form" id="authForm">
                <input id="authUsername" class="auth-input" type="text" placeholder="Логин" autocomplete="off" autocapitalize="none" spellcheck="false">
                <input id="authPassword" class="auth-input" type="password" placeholder="Пароль" autocomplete="off">
                <div class="auth-actions">
                    <button id="authLoginBtn" class="auth-btn primary" type="submit">Войти</button>
                </div>
                <div class="auth-network">
                    <div class="auth-network-head">
                        <div class="auth-network-title">Адрес сервера</div>
                        <div class="auth-network-note" id="authNetworkNote">Автоматически подставляется из настроек</div>
                    </div>
                    <div class="auth-network-row">
                        <input id="authApiBaseUrl" class="auth-input auth-input--compact" type="url" placeholder="https://msgs.zalikus.org" autocomplete="off">
                        <button id="authNetworkSaveBtn" class="auth-btn auth-btn--ghost" type="button">Сохранить</button>
                    </div>
                    <p class="auth-network-help">Если сервер не найден, укажите публичный `https://` адрес и попробуйте снова.</p>
                </div>
                <div class="auth-footer">
                    <button id="authGuestBtn" class="auth-link" type="button">Продолжить как гость</button>
                    <button id="authRegisterBtn" class="auth-link" type="button">Создать аккаунт</button>
                </div>
                <div class="auth-error" id="authError"></div>
            </form>
        </div>
    </div>
    <script>
// --- MODULE: bus_events.js ---
// @ts-check
(function() {
    'use strict';

    /**
     * @enum {string}
     */
    const ZaliBusEvents = Object.freeze({
        RECEIVE_MESSAGE: 'receive_message',
        SET_USERS: 'set_users',
        SET_CONTACTS: 'set_contacts',
        SET_SESSION: 'set_session',
        LOAD_HISTORY: 'load_history',
        LOAD_SERVER_HISTORY: 'load_server_history',
        REFRESH_AFTER_KEY: 'refresh_after_key',
        SYNC_ACTIVE_CONVERSATION: 'sync_active_conversation',
        SET_LOADING: 'set_loading',
        SET_CONNECTION_STATUS: 'set_connection_status',
        ON_SEND_SUCCESS: 'on_send_success',
        ON_SEND_ERROR: 'on_send_error',
        REACTION_UPDATED: 'reaction_updated',
        AVATAR_UPDATED: 'avatar_updated',
        TENOR_RESOLVED: 'tenor_resolved',
        AUTH_RESPONSE: 'auth_response',
        NATIVE_RESPONSE: 'native_response',
        ADD_LOG_ENTRY: 'add_log_entry',
        VOICE_EVENT: 'voice_event',
    });

    window.ZaliBusEvents = ZaliBusEvents;
})();


// --- MODULE: api_routes.js ---
// @ts-check
(function() {
    'use strict';

    const API_VERSION_PREFIX = '/api';
    const apiRoute = (path) => `${API_VERSION_PREFIX}${path}`;

    const API_ROUTES = Object.freeze({
        devices: {
            list: apiRoute('/devices'),
            byId: (id) => apiRoute(`/devices/${encodeURIComponent(id)}`),
            approve: apiRoute('/devices/approve'),
            publicByUser: (username) => apiRoute(`/users/${encodeURIComponent(username)}/devices`),
        },
        vault: {
            events: apiRoute('/vault/events'),
        },
        keyEnvelopes: {
            list: (deviceId = '') => apiRoute(`/key-envelopes${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`),
            base: apiRoute('/key-envelopes'),
        },
        historyTickets: apiRoute('/history-tickets'),
        discover: {
            servers: apiRoute('/discover/servers'),
        },
        auth: {
            me: apiRoute('/auth/me'),
            register: apiRoute('/auth/register'),
            login: apiRoute('/auth/login'),
            wsTicket: apiRoute('/auth/ws-ticket'),
        },
        contacts: {
            list: apiRoute('/contacts'),
            byUsername: (username) => apiRoute(`/contacts/${encodeURIComponent(username)}`),
        },
        users: {
            search: (query) => apiRoute(`/users?q=${encodeURIComponent(query)}`),
        },
        avatar: {
            base: apiRoute('/avatar'),
            byUsername: (username) => apiRoute(`/avatar/${encodeURIComponent(username)}`),
        },
        invites: {
            join: (code) => apiRoute(`/invites/${encodeURIComponent(code)}/join`),
        },
        messages: {
            direct: (user) => apiRoute(`/messages/${encodeURIComponent(user)}`),
            reaction: (id) => apiRoute(`/message/${encodeURIComponent(id)}/reaction`),
            download: (id) => apiRoute(`/download/${encodeURIComponent(id)}`),
            upload: apiRoute('/upload'),
        },
        servers: {
            list: apiRoute('/servers'),
            join: apiRoute('/servers/join'),
            byId: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}`),
            channels: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels`),
            channel: (serverId, channelId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}`),
            channelMessages: (serverId, channelId, limit, offset) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}&offset=${offset}`),
            assets: (serverId, kind) => apiRoute(`/servers/${encodeURIComponent(serverId)}/assets/${kind}`),
            members: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/members`),
            member: (serverId, username) => apiRoute(`/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(username)}`),
            roles: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/roles`),
            role: (serverId, roleId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}`),
            invites: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/invites`),
            permissions: (serverId, channelId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/permissions`),
        },
    });

    window.ZaliApiRoutes = API_ROUTES;
})();


// --- MODULE: native_types.js ---
(function() {
    'use strict';

    /**
     * @enum {string}
     */
    const ZaliNativeMessageTypes = Object.freeze({
        ADD_CONTACT_REQUEST: "ADD_CONTACT_REQUEST",
        API_REQUEST: "API_REQUEST",
        AUTH_REQUEST: "AUTH_REQUEST",
        DELETE_AVATAR_REQUEST: "DELETE_AVATAR_REQUEST",
        DOWNLOAD_ATTACHMENT: "DOWNLOAD_ATTACHMENT",
        LOAD_AVATAR_REQUEST: "LOAD_AVATAR_REQUEST",
        LOAD_SERVER_HISTORY: "LOAD_SERVER_HISTORY",
        NETWORK_CONFIG: "NETWORK_CONFIG",
        PERSIST_DEVICE_IDENTITY: "PERSIST_DEVICE_IDENTITY",
        REFRESH_HISTORY: "REFRESH_HISTORY",
        REMOVE_CONTACT_REQUEST: "REMOVE_CONTACT_REQUEST",
        RESOLVE_TENOR: "RESOLVE_TENOR",
        SAVE_MESSAGE_CACHE: "SAVE_MESSAGE_CACHE",
        SAVE_PENDING_OUTBOX: "SAVE_PENDING_OUTBOX",
        SAVE_STYLE: "SAVE_STYLE",
        SEND_MESSAGE: "SEND_MESSAGE",
        SET_KEY: "SET_KEY",
        SET_MESSAGE_REACTION: "SET_MESSAGE_REACTION",
        SET_SESSION: "SET_SESSION",
        SHOW_NOTIFICATION: "SHOW_NOTIFICATION",
        START_DRAG: "START_DRAG",
        UPLOAD_AVATAR_REQUEST: "UPLOAD_AVATAR_REQUEST",
        VOICE_EVENT: "VOICE_EVENT",
    });

    window.ZaliNativeMessageTypes = ZaliNativeMessageTypes;
})();


// --- MODULE: auth.js ---
// @ts-check
(function() {
    'use strict';

    const slices = window.ZaliStateSlices || (window.ZaliStateSlices = {});

    slices.auth = {
        createState() {
            return {
                session: {
                    username: '',
                    token: null,
                    guest: true,
                },
                auth: {
                    visible: true,
                    loading: false,
                    error: '',
                    mode: 'login',
                    fieldsCleared: false,
                    vaultPassphrase: '',
                    cloudVaultSyncEnabled: false,
                },
                deviceTrust: {
                    current: null,
                    devices: [],
                    exportPackage: '',
                    exportCode: '',
                    importPackage: '',
                    importCode: '',
                    status: '',
                },
            };
        },
    };
})();


// --- MODULE: contacts.js ---
// @ts-check
(function() {
    'use strict';

    const slices = window.ZaliStateSlices || (window.ZaliStateSlices = {});

    slices.contacts = {
        createState() {
            return {
                users: [],
                contacts: [],
                contactAddMode: false,
            };
        },
    };
})();


// --- MODULE: messaging.js ---
// @ts-check
(function() {
    'use strict';

    const slices = window.ZaliStateSlices || (window.ZaliStateSlices = {});

    slices.messaging = {
        createState() {
            return {
                chats: {},
                current: null,
                unread: {},
                channelUnread: {},
                mutedChats: {},
                wsOn: false,
                loading: true,
                searchQ: '',
                navMode: 'dm',
                serverChats: {},
                draftAttachments: [],
            };
        },
    };
})();


// --- MODULE: servers.js ---
// @ts-check
(function() {
    'use strict';

    const slices = window.ZaliStateSlices || (window.ZaliStateSlices = {});

    slices.servers = {
        createState() {
            return {
                activeServer: null,
                activeChannel: null,
                servers: [],
                publicServers: [],
                serverModal: {
                    mode: 'create',
                    serverId: null,
                    activeSection: 'overview',
                    colorPickers: {},
                    roleCreateOpen: false,
                    channelCreateOpen: false,
                    members: [],
                    roles: [],
                    channels: [],
                    draftRoles: [],
                    createDraft: null,
                    joinLink: '',
                    selectedChannelId: null,
                    channelPermissions: [],
                    loading: false,
                    saving: false,
                    error: '',
                },
            };
        },
    };
})();


// --- MODULE: voice.js ---
// @ts-check
(function() {
    'use strict';

    const slices = window.ZaliStateSlices || (window.ZaliStateSlices = {});

    slices.voice = {
        createState() {
            return {
                supported: !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
                roomId: '',
                roomType: '',
                serverId: '',
                channelId: '',
                targetUser: '',
                inviter: '',
                status: 'idle',
                muted: false,
                localStream: null,
                peerConnections: new Map(),
                remoteAudios: new Map(),
                participants: [],
                outgoingInvite: null,
                incomingInvite: null,
                socket: null,
                socketReady: false,
                callTrack: null,
                audioContext: null,
                playbackUnlocked: false,
                meterRaf: 0,
                meterLocal: null,
                meterRemote: new Map(),
                remotePlaybackNodes: new Map(),
                meterLevels: {
                    local: 0,
                    remote: 0,
                },
                traceLines: [],
            };
        },
    };
})();


// --- MODULE: wasm_bridge.js ---
// @ts-check
// Lazily loads the WASM build of core/ (see scripts/build_web_wasm.sh) and exposes
// pack/unpack helpers for the .zali archive format to the rest of interface.js.
// Only relevant when running as a plain browser tab with no native shell — the
// macOS/Windows clients pack/unpack archives natively and never touch this module.
// Dynamic import() here resolves relative to the document URL, so web/wasm-pkg/
// must be served alongside web/index.html.
(function() {
    'use strict';

    let readyPromise = null;

    function load() {
        if (!readyPromise) {
            readyPromise = import('./wasm-pkg/zali_core.js')
                .then(async (mod) => {
                    await mod.default();
                    return mod;
                })
                .catch((error) => {
                    readyPromise = null;
                    throw error;
                });
        }
        return readyPromise;
    }

    window.ZaliWasm = {
        async isAvailable() {
            try {
                await load();
                return true;
            } catch (e) {
                return false;
            }
        },

        /**
         * @param {string} sender
         * @param {string} text
         * @param {string} key
         * @param {number} keyVersion
         * @param {Array<{name:string, archivePath:string, mimeType:string, kind:string, bytes:Uint8Array}>} [attachments]
         * @returns {Promise<Uint8Array>}
         */
        async packMessage(sender, text, key, keyVersion, attachments) {
            const mod = await load();
            const jsAttachments = (attachments || []).map(a => ({
                name: a.name,
                archivePath: a.archivePath,
                mimeType: a.mimeType,
                kind: a.kind,
                bytes: a.bytes instanceof Uint8Array ? a.bytes : new Uint8Array(a.bytes),
            }));
            return mod.pack_message_wasm(sender, text, key, keyVersion || 0, jsAttachments);
        },

        /**
         * @param {Uint8Array} archiveBytes
         * @param {string} key
         * @returns {Promise<{sender:string, text:string, timestamp:number, keyVersion:number, attachments:Array<{name:string,archivePath:string,mimeType:string,kind:string,bytes:Uint8Array}>}>}
         */
        async unpackMessage(archiveBytes, key) {
            const mod = await load();
            const bytes = archiveBytes instanceof Uint8Array ? archiveBytes : new Uint8Array(archiveBytes);
            return mod.unpack_message_wasm(bytes, key);
        },
    };
})();


// --- MODULE: bus.js ---
// @ts-check
/**
 * @enum {string}
 */
const ZaliBusEvents = window.ZaliBusEvents || Object.freeze({
    RECEIVE_MESSAGE: 'receive_message',
    SET_USERS: 'set_users',
    SET_CONTACTS: 'set_contacts',
    SET_SESSION: 'set_session',
    LOAD_HISTORY: 'load_history',
    LOAD_SERVER_HISTORY: 'load_server_history',
    REFRESH_AFTER_KEY: 'refresh_after_key',
    SYNC_ACTIVE_CONVERSATION: 'sync_active_conversation',
    SET_LOADING: 'set_loading',
    SET_CONNECTION_STATUS: 'set_connection_status',
    ON_SEND_SUCCESS: 'on_send_success',
    ON_SEND_ERROR: 'on_send_error',
    REACTION_UPDATED: 'reaction_updated',
    AVATAR_UPDATED: 'avatar_updated',
    TENOR_RESOLVED: 'tenor_resolved',
    AUTH_RESPONSE: 'auth_response',
    NATIVE_RESPONSE: 'native_response',
    ADD_LOG_ENTRY: 'add_log_entry',
    VOICE_EVENT: 'voice_event',
});

window.ZaliBusEvents = ZaliBusEvents;

class ZaliBus {
    constructor() {
        this.handlers = new Map(); // "address:command" -> function
        this.listeners = new Map(); // eventName -> Array<function>
    }

    /**
     * Register a command handler for a specific module namespace and command.
     * @param {string} address - Namespace (e.g. 'zali_crypto')
     * @param {string} command - Action name (e.g. 'encrypt')
     * @param {Function} handler - The handler function
     */
    registerCommand(address, command, handler) {
        const key = `${address}:${command}`;
        if (address === 'zali_interface') {
            const known = new Set(Object.values(ZaliBusEvents));
            if (!known.has(command)) {
                console.warn(`[zali_bus] Unknown command registered: ${key}`);
            }
        }
        if (this.handlers.has(key)) {
            console.warn(`[zali_bus] Command handler for ${key} is already registered. Overwriting.`);
        }
        this.handlers.set(key, handler);
    }

    /**
     * Call a registered command and return its result.
     * @param {string} addressCommand - In format "namespace:command"
     * @param  {...any} args - Arguments passed to the handler
     */
    send(addressCommand, ...args) {
        if (this.handlers.has(addressCommand)) {
            const handler = this.handlers.get(addressCommand);
            return handler(...args);
        } else {
            console.error(`[zali_bus] No handler registered for command: ${addressCommand}`);
            return null;
        }
    }

    /**
     * Register a listener for an event broadcasted by pub/sub.
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     */
    subscribe(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event).push(callback);
    }

    /**
     * Publish an event to all subscribers.
     * @param {string} event - Event name
     * @param  {...any} args - Arguments passed to the subscribers
     */
    publish(event, ...args) {
        if (this.listeners.has(event)) {
            this.listeners.get(event).forEach(cb => {
                try {
                    cb(...args);
                } catch (e) {
                    console.error(`[zali_bus] Error in subscriber for event ${event}:`, e);
                }
            });
        }
    }
}
window.ZaliBus = ZaliBus;


// --- MODULE: loader.js ---
// @ts-check
class ZaliLoader {
    constructor() {
        this.bus = new ZaliBus();
        this.modules = new Map();
    }

    /**
     * Registers a module.
     * @param {Object} module - Module instance must have a name string and optionally an init() method.
     */
    register(module) {
        if (!module || !module.name) {
            console.error("[zali_loader] Failed to register invalid module:", module);
            return;
        }
        this.modules.set(module.name, module);
        console.log(`[zali_loader] Module registered: ${module.name}`);
    }

    /**
     * Initializes all registered modules.
     */
    init() {
        console.log("[zali_loader] Bootstrapping modules...");

        // Register a system command to retrieve module info
        this.bus.registerCommand('loader', 'get_modules', () => Array.from(this.modules.keys()));

        // Initialize each module
        for (let [name, module] of this.modules) {
            try {
                if (typeof module.init === 'function') {
                    module.init(this);
                    console.log(`[zali_loader] Module initialized successfully: ${name}`);
                }
            } catch (e) {
                console.error(`[zali_loader] Error during initialization of module ${name}:`, e);
            }
        }

        console.log("[zali_loader] Bootstrap finished.");
    }
}
window.ZaliLoader = ZaliLoader;


// --- MODULE: styler.js ---
// @ts-check
class ZaliStyler {
    constructor() {
        this.name = 'zali_styler';
        this.currentKey = '';
        
        // Custom premium themes matching rich aesthetics
        this.themes = {
            lime: {
                '--accent-rgb': '203,255,0',
                '--lime': '#cbff00',
                '--lime-dim': 'rgba(203,255,0,.1)',
                '--lime-glow': 'rgba(203,255,0,.25)',
                '--lime-soft': 'rgba(203,255,0,.06)',
                '--bg': '#090b0e',
                '--sidebar': 'rgba(11,13,16,.9)',
                '--text': '#f2f2f2',
                '--text2': 'rgba(255,255,255,.5)',
                '--text3': 'rgba(255,255,255,.25)',
                '--border': 'rgba(255,255,255,.07)',
            },
            cyber: {
                '--accent-rgb': '255,0,85',
                '--lime': '#ff0055',
                '--lime-dim': 'rgba(255,0,85,.15)',
                '--lime-glow': 'rgba(255,0,85,.35)',
                '--lime-soft': 'rgba(255,0,85,.08)',
                '--bg': '#0a0512',
                '--sidebar': 'rgba(20,10,32,.92)',
                '--text': '#00ffcc',
                '--text2': 'rgba(0,255,204,.6)',
                '--text3': 'rgba(0,255,204,.3)',
                '--border': 'rgba(0,255,204,.15)',
            },
            matrix: {
                '--accent-rgb': '0,255,51',
                '--lime': '#00ff33',
                '--lime-dim': 'rgba(0,255,51,.15)',
                '--lime-glow': 'rgba(0,255,51,.35)',
                '--lime-soft': 'rgba(0,255,51,.07)',
                '--bg': '#020502',
                '--sidebar': 'rgba(4,16,6,.95)',
                '--text': '#39ff14',
                '--text2': 'rgba(57,255,20,.65)',
                '--text3': 'rgba(57,255,20,.35)',
                '--border': 'rgba(57,255,20,.2)',
            },
            ocean: {
                '--accent-rgb': '0,210,255',
                '--lime': '#00d2ff',
                '--lime-dim': 'rgba(0,210,255,.15)',
                '--lime-glow': 'rgba(0,210,255,.3)',
                '--lime-soft': 'rgba(0,210,255,.07)',
                '--bg': '#050f1e',
                '--sidebar': 'rgba(6,22,38,.93)',
                '--text': '#e0f5ff',
                '--text2': 'rgba(224,245,255,.6)',
                '--text3': 'rgba(224,245,255,.3)',
                '--border': 'rgba(224,245,255,.1)',
            },
            mono: {
                '--accent-rgb': '255,255,255',
                '--lime': '#ffffff',
                '--lime-dim': 'rgba(255,255,255,.15)',
                '--lime-glow': 'rgba(255,255,255,.25)',
                '--lime-soft': 'rgba(255,255,255,.05)',
                '--bg': '#121212',
                '--sidebar': 'rgba(26,26,26,.9)',
                '--text': '#ffffff',
                '--text2': 'rgba(255,255,255,.6)',
                '--text3': 'rgba(255,255,255,.35)',
                '--border': 'rgba(255,255,255,.12)',
            },
            ember: {
                '--accent-rgb': '255,122,46',
                '--lime': '#ff7a2e',
                '--lime-dim': 'rgba(255,122,46,.14)',
                '--lime-glow': 'rgba(255,122,46,.34)',
                '--lime-soft': 'rgba(255,122,46,.08)',
                '--bg': '#120805',
                '--sidebar': 'rgba(27,12,8,.93)',
                '--text': '#fff0e5',
                '--text2': 'rgba(255,240,229,.62)',
                '--text3': 'rgba(255,240,229,.32)',
                '--border': 'rgba(255,194,150,.13)',
            },
            aurora: {
                '--accent-rgb': '91,255,196',
                '--lime': '#5bffc4',
                '--lime-dim': 'rgba(91,255,196,.13)',
                '--lime-glow': 'rgba(91,255,196,.32)',
                '--lime-soft': 'rgba(91,255,196,.07)',
                '--bg': '#041012',
                '--sidebar': 'rgba(5,22,24,.94)',
                '--text': '#e8fff8',
                '--text2': 'rgba(232,255,248,.6)',
                '--text3': 'rgba(232,255,248,.3)',
                '--border': 'rgba(128,255,221,.12)',
            },
            graphite: {
                '--accent-rgb': '180,190,205',
                '--lime': '#b4becd',
                '--lime-dim': 'rgba(180,190,205,.14)',
                '--lime-glow': 'rgba(180,190,205,.26)',
                '--lime-soft': 'rgba(180,190,205,.06)',
                '--bg': '#0b0d10',
                '--sidebar': 'rgba(17,20,25,.94)',
                '--text': '#f4f6f8',
                '--text2': 'rgba(244,246,248,.58)',
                '--text3': 'rgba(244,246,248,.3)',
                '--border': 'rgba(244,246,248,.1)',
            },
            rose: {
                '--accent-rgb': '255,115,151',
                '--lime': '#ff7397',
                '--lime-dim': 'rgba(255,115,151,.14)',
                '--lime-glow': 'rgba(255,115,151,.32)',
                '--lime-soft': 'rgba(255,115,151,.07)',
                '--bg': '#12070c',
                '--sidebar': 'rgba(28,10,17,.93)',
                '--text': '#fff0f4',
                '--text2': 'rgba(255,240,244,.62)',
                '--text3': 'rgba(255,240,244,.32)',
                '--border': 'rgba(255,178,198,.13)',
            },
            violet: {
                '--accent-rgb': '174,92,255',
                '--lime': '#ae5cff',
                '--lime-dim': 'rgba(174,92,255,.16)',
                '--lime-glow': 'rgba(174,92,255,.34)',
                '--lime-soft': 'rgba(174,92,255,.08)',
                '--bg': '#0d0718',
                '--sidebar': 'rgba(18,10,34,.94)',
                '--text': '#f6efff',
                '--text2': 'rgba(246,239,255,.62)',
                '--text3': 'rgba(246,239,255,.32)',
                '--border': 'rgba(208,174,255,.14)',
            }
        };

        // CSS variable defaults that can be modified by the styler
        this.currentVars = {};
        this.currentRadius = 18;
        this.saveTimer = null;
    }

    init(loader) {
        this.bus = loader.bus;

        // Register commands on the bus
        this.bus.registerCommand('zali_styler', 'set_theme',         (themeName) => this.setTheme(themeName));
        this.bus.registerCommand('zali_styler', 'set_variable',      (name, val) => this.setVariable(name, val));
        this.bus.registerCommand('zali_styler', 'get_themes',        ()          => Object.keys(this.themes));
        this.bus.registerCommand('zali_styler', 'save_style',        ()          => this.saveStyleToNative());
        this.bus.registerCommand('zali_styler', 'set_key',           (key)       => this.setKey(key));

        // Load saved style from UserDefaults if available
        const restoredSavedStyle = this._loadSavedStyle();

        const storedKey = this._loadStoredKey();
        if (storedKey) {
            this.setKey(storedKey);
        }

        const storedTheme = this.loadStoredThemeName();
        if (storedTheme && this.themes[storedTheme]) {
            this.setTheme(storedTheme, { persist: false, remember: false });
        } else if (!restoredSavedStyle) {
            this.setTheme('lime', { persist: false, remember: false });
        } else {
            this.markActiveThemeButton(storedTheme || '');
        }
    }

    _cryptoKeyStorageKey() {
        return window.__ZALI_INTERFACE?.cryptoKeyStorageKey?.() || 'zali_crypto_key_v2';
    }

    _conversationKeysStorageKey() {
        return window.__ZALI_INTERFACE?.conversationKeysStorageKey?.() || 'zali_conversation_keys_v2';
    }

    _loadStoredKey() {
        try {
            const scope = String(window.__ZALI_ACTIVE_CONVERSATION_SCOPE || '').trim();
            if (scope) {
                const convKey = this._conversationKeysStorageKey();
                const rawMap = sessionStorage.getItem(convKey) || localStorage.getItem(convKey);
                if (rawMap) {
                    const storedMap = JSON.parse(rawMap) || {};
                    const scoped = String(storedMap[scope] || '').trim();
                    if (scoped) return scoped;
                }
            }
            const keyName = this._cryptoKeyStorageKey();
            const stored = (sessionStorage.getItem(keyName) || localStorage.getItem(keyName) || '').trim();
            if (stored) {
                try {
                    sessionStorage.setItem(keyName, stored);
                    localStorage.removeItem(keyName);
                } catch (e) {}
            }
            if (stored) return stored;
        } catch (e) {}
        return '';
    }

    /**
     * Try to load persisted custom CSS from the app's saved state.
     * The native layer can inject `window.__ZALI_SAVED_CSS` at startup.
     */
    _loadSavedStyle() {
        if (window.__ZALI_SAVED_CSS) {
            // Inject the saved CSS blob as a <style> tag override
            let styleTag = document.getElementById('zali-custom-style');
            if (!styleTag) {
                styleTag = document.createElement('style');
                styleTag.id = 'zali-custom-style';
                document.head.appendChild(styleTag);
            }
            styleTag.textContent = window.__ZALI_SAVED_CSS;
            this._ingestSavedVars(window.__ZALI_SAVED_CSS);
            console.log('[zali_styler] Восстановлены сохраненные стили из UserDefaults');
            return true;
        }
        return false;
    }

    _ingestSavedVars(cssText) {
        const varRegex = /(--[A-Za-z0-9-_]+)\s*:\s*([^;]+);/g;
        let match;
        while ((match = varRegex.exec(cssText)) !== null) {
            const [, name, value] = match;
            this.currentVars[name] = value.trim();
        }

        const radiusValue = this.currentVars['--r-msg'];
        if (radiusValue) {
            const parsed = parseInt(radiusValue, 10);
            if (!Number.isNaN(parsed)) {
                this.currentRadius = parsed;
            }
        }
    }

    nativeBridge() {
        return window.__ZALI_NATIVE || null;
    }

    nativeSupports(capability) {
        return !!this.nativeBridge()?.supports?.[capability];
    }

    postNativeMessage(payload) {
        const bridge = this.nativeBridge();
        if (!bridge || typeof bridge.postMessage !== 'function') return false;
        return !!bridge.postMessage(payload);
    }

    themeStorageKey() {
        return 'zali_theme_name_v1';
    }

    loadStoredThemeName() {
        try {
            return String(localStorage.getItem(this.themeStorageKey()) || '').trim();
        } catch (e) {
            return '';
        }
    }

    saveStoredThemeName(themeName) {
        try {
            localStorage.setItem(this.themeStorageKey(), String(themeName || '').trim());
        } catch (e) {}
    }

    markActiveThemeButton(themeName) {
        try {
            document.querySelectorAll('.btn-theme[data-theme]').forEach(btn => {
                const active = String(btn.getAttribute('data-theme') || '') === String(themeName || '');
                btn.classList.toggle('active', active);
                btn.setAttribute('aria-pressed', String(active));
            });
        } catch (e) {}
    }

    setTheme(themeName, options = {}) {
        const theme = this.themes[themeName];
        if (!theme) {
            console.warn(`[zali_styler] Тема "${themeName}" не найдена`);
            return false;
        }

        for (const [key, val] of Object.entries(theme)) {
            this.setVariable(key, val, { persist: false });
            this.currentVars[key] = val;
        }

        if (options.remember !== false) {
            this.saveStoredThemeName(themeName);
        }
        this.markActiveThemeButton(themeName);
        console.log(`[zali_styler] Установлена цветовая схема "${themeName}"`);
        if (options.persist !== false) this.saveStyleToNative();
        return true;
    }

    setVariable(name, val, options = {}) {
        document.documentElement.style.setProperty(name, val);
        this.currentVars[name] = val;
        if (options.persist !== false) {
            this.queueSaveStyle();
        }
    }

    queueSaveStyle() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.saveStyleToNative();
        }, 120);
    }

    setKey(key) {
        this.currentKey = (key || '').trim();
        try {
            const keyName = this._cryptoKeyStorageKey();
            if (this.currentKey) {
                sessionStorage.setItem(keyName, this.currentKey);
                localStorage.removeItem(keyName);
            } else {
                sessionStorage.removeItem(keyName);
                localStorage.removeItem(keyName);
            }
        } catch (e) {}

        try {
            window.__ZALI_SAVED_KEY = this.currentKey;
        } catch (e) {}
        try {
            const scope = String(window.__ZALI_ACTIVE_CONVERSATION_SCOPE || '').trim();
            if (scope) {
                const convKey = this._conversationKeysStorageKey();
                const raw = sessionStorage.getItem(convKey) || localStorage.getItem(convKey);
                const stored = raw ? (JSON.parse(raw) || {}) : {};
                if (this.currentKey) {
                    stored[scope] = this.currentKey;
                } else {
                    delete stored[scope];
                }
                sessionStorage.setItem(convKey, JSON.stringify(stored));
                localStorage.removeItem(convKey);
            }
        } catch (e) {}

        const input = document.getElementById('inputCryptoKey');
        if (input && input.value !== this.currentKey) {
            input.value = this.currentKey;
        }
        this.updateKeyDisplay();

        console.log('[zali_styler] Ключ E2E обновлён в UI');
    }

    updateKeyDisplay(meta = null) {
        const valueEl = document.getElementById('currentCryptoKeyValue');
        const metaEl = document.getElementById('currentCryptoKeyMeta');
        const key = (this.currentKey || '').trim();
        if (valueEl) valueEl.textContent = key ? `задан (${key.length} символов)` : 'не задан';
        if (metaEl) {
            metaEl.textContent = meta || 'Контекст: общий ключ';
        }
    }

    /**
     * Compiles all current CSS variable overrides into a :root {} block
     * and sends them to the native Swift layer for persistence in Web/style.css.
     */
    saveStyleToNative() {
        if (!this.nativeSupports('saveStyle')) {
            console.log('[zali_styler] Native bridge не обнаружен, сохранение пропущено');
            return;
        }

        // Build :root override block from all current vars
        const varLines = Object.entries(this.currentVars)
            .map(([k, v]) => `    ${k}: ${v};`)
            .join('\n');

        const cssBlock = `:root {\n${varLines}\n    --r-msg: ${this.currentRadius}px;\n}\n`;

        this.postNativeMessage({
            type: 'SAVE_STYLE',
            css: cssBlock
        });

        console.log('[zali_styler] Стили отправлены на сохранение в Web/style.css');
    }
}
window.ZaliStyler = ZaliStyler;


// --- MODULE: interface.js ---
// @ts-check

const API_VERSION_PREFIX = '/api';
const AUTH_REQUEST_TIMEOUT_MS = 6500;
const SESSION_RESTORE_TIMEOUT_MS = 12000;
const API_REQUEST_TIMEOUT_MS = 8000;

const NativeMessageTypes = window.ZaliNativeMessageTypes || Object.freeze({
    SEND_MESSAGE: 'SEND_MESSAGE',
    SET_SESSION: 'SET_SESSION',
    REFRESH_HISTORY: 'REFRESH_HISTORY',
    LOAD_SERVER_HISTORY: 'LOAD_SERVER_HISTORY',
    SAVE_STYLE: 'SAVE_STYLE',
    SAVE_MESSAGE_CACHE: 'SAVE_MESSAGE_CACHE',
    SAVE_PENDING_OUTBOX: 'SAVE_PENDING_OUTBOX',
    DOWNLOAD_ATTACHMENT: 'DOWNLOAD_ATTACHMENT',
    START_DRAG: 'START_DRAG',
    RESOLVE_TENOR: 'RESOLVE_TENOR',
    SET_KEY: 'SET_KEY',
    SET_MESSAGE_REACTION: 'SET_MESSAGE_REACTION',
    NETWORK_CONFIG: 'NETWORK_CONFIG',
    VOICE_EVENT: 'VOICE_EVENT',
    AUTH_REQUEST: 'AUTH_REQUEST',
    API_REQUEST: 'API_REQUEST',
    ADD_CONTACT_REQUEST: 'ADD_CONTACT_REQUEST',
    REMOVE_CONTACT_REQUEST: 'REMOVE_CONTACT_REQUEST',
    UPLOAD_AVATAR_REQUEST: 'UPLOAD_AVATAR_REQUEST',
    DELETE_AVATAR_REQUEST: 'DELETE_AVATAR_REQUEST',
    LOAD_AVATAR_REQUEST: 'LOAD_AVATAR_REQUEST',
    SHOW_NOTIFICATION: 'SHOW_NOTIFICATION',
    PERSIST_DEVICE_IDENTITY: 'PERSIST_DEVICE_IDENTITY',
});

const apiRoute = (path) => `${API_VERSION_PREFIX}${path}`;

/**
 * @typedef {Object} ZaliServerModalState
 * @property {'create'|'edit'} mode
 * @property {string|null} serverId
 * @property {string} activeSection
 * @property {Record<string, string>} colorPickers
 * @property {boolean} roleCreateOpen
 * @property {boolean} channelCreateOpen
 * @property {Array<any>} members
 * @property {Array<any>} roles
 * @property {Array<any>} channels
 * @property {Array<any>} draftRoles
 * @property {{name: string, description: string, icon: string, color: string, joinLink: string, isPublic: boolean}|null} createDraft
 * @property {string} joinLink
 * @property {string|null} selectedChannelId
 * @property {Array<any>} channelPermissions
 * @property {boolean} loading
 * @property {boolean} saving
 * @property {string} error
 */

/**
 * @typedef {Object} ZaliSessionState
 * @property {string} username
 * @property {string|null} token
 * @property {boolean} guest
 */

/**
 * @typedef {Object} ZaliAuthState
 * @property {boolean} visible
 * @property {boolean} loading
 * @property {string} error
 * @property {'login'|'register'} mode
 * @property {boolean} fieldsCleared
 * @property {string} vaultPassphrase
 * @property {boolean} cloudVaultSyncEnabled
 */

/**
 * @typedef {Object} ZaliDeviceTrustState
 * @property {any|null} current
 * @property {Array<any>} devices
 * @property {string} exportPackage
 * @property {string} exportCode
 * @property {string} importPackage
 * @property {string} importCode
 * @property {string} status
 */

/**
 * @typedef {Object} ZaliMessageWindowState
 * @property {string} conversationKey
 * @property {number} start
 * @property {number} end
 * @property {number} avgHeight
 * @property {number} [count]
 * @property {boolean} [useWindow]
 */

/**
 * @typedef {Object} ZaliInterfaceState
 * @property {Record<string, any[]>} chats
 * @property {string[]} users
 * @property {string[]} contacts
 * @property {string|null} current
 * @property {Record<string, number>} unread
 * @property {boolean} wsOn
 * @property {boolean} loading
 * @property {string} searchQ
 * @property {'dm'|'servers'} navMode
 * @property {string|null} activeServer
 * @property {string|null} activeChannel
 * @property {Array<any>} servers
 * @property {Array<any>} publicServers
 * @property {Record<string, any[]>} serverChats
 * @property {Array<any>} draftAttachments
 * @property {ZaliServerModalState} serverModal
 * @property {ZaliSessionState} session
 * @property {ZaliAuthState} auth
 * @property {ZaliDeviceTrustState} deviceTrust
 */

const DefaultApiRoutes = Object.freeze({
    devices: {
        list: apiRoute('/devices'),
        byId: (id) => apiRoute(`/devices/${encodeURIComponent(id)}`),
        approve: apiRoute('/devices/approve'),
        publicByUser: (username) => apiRoute(`/users/${encodeURIComponent(username)}/devices`),
    },
    vault: {
        events: apiRoute('/vault/events'),
    },
    keyEnvelopes: {
        list: (deviceId = '') => apiRoute(`/key-envelopes${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`),
        base: apiRoute('/key-envelopes'),
    },
    historyTickets: apiRoute('/history-tickets'),
    discover: {
        servers: apiRoute('/discover/servers'),
    },
    auth: {
        me: apiRoute('/auth/me'),
        register: apiRoute('/auth/register'),
        login: apiRoute('/auth/login'),
        wsTicket: apiRoute('/auth/ws-ticket'),
    },
    contacts: {
        list: apiRoute('/contacts'),
        byUsername: (username) => apiRoute(`/contacts/${encodeURIComponent(username)}`),
    },
    users: {
        search: (query) => apiRoute(`/users?q=${encodeURIComponent(query)}`),
    },
    avatar: {
        base: apiRoute('/avatar'),
        byUsername: (username) => apiRoute(`/avatar/${encodeURIComponent(username)}`),
    },
    invites: {
        join: (code) => apiRoute(`/invites/${encodeURIComponent(code)}/join`),
    },
    messages: {
        direct: (user) => apiRoute(`/messages/${encodeURIComponent(user)}`),
        reaction: (id) => apiRoute(`/message/${encodeURIComponent(id)}/reaction`),
        download: (id) => apiRoute(`/download/${encodeURIComponent(id)}`),
    },
    servers: {
        list: apiRoute('/servers'),
        join: apiRoute('/servers/join'),
        byId: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}`),
        channels: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels`),
        channel: (serverId, channelId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}`),
        channelMessages: (serverId, channelId, limit, offset) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}&offset=${offset}`),
        assets: (serverId, kind) => apiRoute(`/servers/${encodeURIComponent(serverId)}/assets/${kind}`),
        members: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/members`),
        member: (serverId, username) => apiRoute(`/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(username)}`),
        roles: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/roles`),
        role: (serverId, roleId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}`),
        invites: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/invites`),
        permissions: (serverId, channelId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/permissions`),
    },
});

class ZaliInterface {
    constructor() {
        this.name = 'zali_interface';

        const stateSlices = window.ZaliStateSlices || {};
        /** @type {ZaliInterfaceState} */
        this.S = Object.assign(
            {},
            stateSlices.auth?.createState?.() || {},
            stateSlices.contacts?.createState?.() || {},
            stateSlices.messaging?.createState?.() || {},
            stateSlices.servers?.createState?.() || {},
        );
        this.tenorCache = new Map();
        this.tenorPending = new Set();
        this.nativeAuthRequests = new Map();
        this.nativeRequests = new Map();
        this.avatarCache = new Map();
        this.avatarRequests = new Map();
        this.avatarFetchSeq = new Map();
        this.serverAssetCache = new Map();
        this.serverAssetRequests = new Map();
        this.serverAssetFetchSeq = new Map();
        this.colorWheelBindings = new Set();
        this.messageAnimSeen = new Set();
        this.mediaSizeCache = new Map();
        this.storageWarningSeen = new Set();
        this.reactionOptions = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
        this.voiceSocketGeneration = 0;
        this.voiceSocketReconnectTimer = null;
        this.voiceSocketReconnectDelayMs = 1000;
        this.voiceSocketPingTimer = null;
        this.pendingMessagesScroll = null;
        this.pendingOutboxFlushTimer = null;
        this.sendWatchdogTimers = new Map();
        this.messageSyncTimer = null;
        this.energyMaintenanceBound = false;
        this.conversationSyncAt = new Map();
        this.conversationRefreshTimers = new Map();
        this.historyLoadSeq = 0;
        this.serverHistoryLoadSeq = new Map();
        this.messageScrollRaf = 0;
        this.messageRenderRaf = 0;
        this.sessionBootstrapInProgress = false;
        this.cloudVaultSyncTimer = 0;
        this.cloudVaultSyncInFlight = false;
        this.bridgeProtocol = window.__ZALI_BRIDGE_PROTOCOL__ || null;
        this.apiRoutes = window.ZaliApiRoutes || DefaultApiRoutes;
        this.clearLegacyKeyMaterial();
        this.S.auth.cloudVaultSyncEnabled = this.loadVaultCloudSyncEnabled();
        /** @type {ZaliMessageWindowState} */
        this.messageWindow = {
            conversationKey: '',
            start: 0,
            end: 0,
            avgHeight: 92,
        };
        this.postAuthSetupInFlight = false;
        this.postAuthSetupRunId = 0;
        this.lastNativeConversationKeySignature = '';
        this.voice = stateSlices.voice?.createState?.() || {
            supported: !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
            roomId: '',
            roomType: '',
            serverId: '',
            channelId: '',
            targetUser: '',
            inviter: '',
            status: 'idle',
            muted: false,
            localStream: null,
            peerConnections: new Map(),
            remoteAudios: new Map(),
            participants: [],
            outgoingInvite: null,
            incomingInvite: null,
            socket: null,
            socketReady: false,
            callTrack: null,
            audioContext: null,
            playbackUnlocked: false,
            meterRaf: 0,
            meterLocal: null,
            meterRemote: new Map(),
            remotePlaybackNodes: new Map(),
            meterLevels: {
                local: 0,
                remote: 0,
            },
            traceLines: [],
        };

        const cachedMessages = this.loadStoredMessageCache();
        this.S.chats = cachedMessages.chats || {};
        this.S.serverChats = cachedMessages.serverChats || {};
        this.S.mutedChats = this.loadStoredMutedChats();
        // Per-peer/per-channel "have we already synced this at least once this
        // session" markers. A history merge (catch-up sweep, active-conversation
        // refresh, etc.) only fires a notification for a NEWLY inserted message once
        // the peer/channel has been primed once already — otherwise the very first
        // history load (login, opening a new chat) would replay the entire backlog
        // as a flood of notifications instead of being silently primed as baseline.
        this._historyPrimedPeers = new Set();
        this._historyPrimedChannels = new Set();
        this.uiV2Enabled = this.loadUiV2Enabled();
        this.uiV2Segments = this.loadUiV2Segments();
        this.experimentalDesign = this.loadExperimentalDesign();
    }

    init(loader) {
        this.bus = loader.bus;
        try {
            window.__ZALI_INTERFACE = this;
        } catch (e) {}
        this.S.navMode = this.loadStoredNavMode();

        // Register UI update commands on the bus
        const E = window.ZaliBusEvents || {};
        this.bus.registerCommand('zali_interface', E.RECEIVE_MESSAGE || 'receive_message', (data) => this.receiveMessage(data));
        this.bus.registerCommand('zali_interface', E.SET_USERS || 'set_users', (users) => this.setUsers(users));
        this.bus.registerCommand('zali_interface', E.SET_CONTACTS || 'set_contacts', (contacts) => this.setContacts(contacts));
        this.bus.registerCommand('zali_interface', E.SET_SESSION || 'set_session', (session) => this.setSession(session));
        this.bus.registerCommand('zali_interface', E.LOAD_HISTORY || 'load_history', (messages) => this.loadHistory(messages));
        this.bus.registerCommand('zali_interface', E.LOAD_SERVER_HISTORY || 'load_server_history', (payload) => this.loadServerHistory(payload));
        this.bus.registerCommand('zali_interface', E.REFRESH_AFTER_KEY || 'refresh_after_key', () => this.refreshAfterKey());
        this.bus.registerCommand('zali_interface', E.SYNC_ACTIVE_CONVERSATION || 'sync_active_conversation', (payload) => this.syncConversationFromNative(payload));
        this.bus.registerCommand('zali_interface', E.SET_LOADING || 'set_loading', (on) => this.setLoading(on));
        this.bus.registerCommand('zali_interface', E.SET_CONNECTION_STATUS || 'set_connection_status', (connected) => this.setConnectionStatus(connected));
        this.bus.registerCommand('zali_interface', E.ON_SEND_SUCCESS || 'on_send_success', (clientId) => this.onSendSuccess(clientId));
        this.bus.registerCommand('zali_interface', E.ON_SEND_ERROR || 'on_send_error', (payload) => this.onSendError(payload));
        this.bus.registerCommand('zali_interface', E.REACTION_UPDATED || 'reaction_updated', (data) => this.onReactionUpdated(data));
        this.bus.registerCommand('zali_interface', E.AVATAR_UPDATED || 'avatar_updated', (data) => this.handleAvatarUpdated(data));
        this.bus.registerCommand('zali_interface', E.TENOR_RESOLVED || 'tenor_resolved', (payload) => this.onTenorResolved(payload));
        this.bus.registerCommand('zali_interface', E.AUTH_RESPONSE || 'auth_response', (payload) => this.onNativeAuthResponse(payload));
        this.bus.registerCommand('zali_interface', E.NATIVE_RESPONSE || 'native_response', (payload) => this.onNativeResponse(payload));
        this.bus.registerCommand('zali_interface', E.ADD_LOG_ENTRY || 'add_log_entry', (data) => this.addLogEntry(data));
        this.bus.registerCommand('zali_interface', E.VOICE_EVENT || 'voice_event', (payload) => this.handleVoiceEvent(payload));

        // Bind events after DOM is loaded
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.bindEvents());
        } else {
            this.bindEvents();
        }

        this.bootstrapSession();
        setTimeout(() => this.syncNativeConversationKeys(), 0);
        this.startEnergyAwareMaintenance();
    }

    // --- HTML Helper Utilities ---
    esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }

    safeCssColor(value) {
        if (!value) return '';
        const trimmed = String(value).trim();
        if (/^(#[0-9a-fA-F]{3,8}|rgb\([^)]+\)|rgba\([^)]+\)|hsl\([^)]+\)|hsla\([^)]+\)|linear-gradient\([^<>"'`\n]+\)|[a-zA-Z]{2,30})$/.test(trimmed)) return trimmed;
        return '';
    }

    uiIcon(name, extraClass = '') {
        const cls = `ui-icon ui-icon-${this.esc(name)}${extraClass ? ` ${this.esc(extraClass)}` : ''}`;
        const attrs = `class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"`;
        const icons = {
            phone: `<svg ${attrs} fill="none"><path d="M7.3 4.75 9.2 8.9c.28.6.13 1.31-.36 1.75l-1.23 1.1c1.09 2.08 2.78 3.75 4.9 4.83l1.04-1.2a1.52 1.52 0 0 1 1.75-.39l4.05 1.74c.65.28 1.03.96.91 1.66l-.37 2.16c-.13.76-.8 1.3-1.57 1.25C9.4 21.25 2.77 14.68 2.22 5.75a1.5 1.5 0 0 1 1.26-1.58l2.18-.41c.69-.13 1.35.26 1.64.99Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
            paperclip: `<svg ${attrs} fill="none"><path d="m8.15 12.55 5.42-5.42a3.26 3.26 0 0 1 4.62 4.61l-6.53 6.53a5.2 5.2 0 0 1-7.35-7.35l6.45-6.45a7.05 7.05 0 0 1 9.98 9.97l-6.52 6.53" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
            gear: `<svg ${attrs} fill="none"><path d="M10.4 3.25h3.2l.55 2.32c.54.2 1.05.5 1.5.87l2.27-.72 1.6 2.76-1.72 1.62c.05.3.08.6.08.9s-.03.6-.08.9l1.72 1.62-1.6 2.76-2.27-.72c-.45.37-.96.67-1.5.87l-.55 2.32h-3.2l-.55-2.32a5.78 5.78 0 0 1-1.5-.87l-2.27.72-1.6-2.76L6.2 11.9a5.6 5.6 0 0 1 0-1.8L4.48 8.48l1.6-2.76 2.27.72c.45-.37.96-.67 1.5-.87l.55-2.32Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="11" r="2.65" stroke="currentColor" stroke-width="1.8"/></svg>`,
            speaker: `<svg ${attrs} fill="none"><path d="M4 9.4v5.2h3.1l4.4 3.35V6.05L7.1 9.4H4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M15.2 8.25a5 5 0 0 1 0 7.5M17.85 5.6a8.75 8.75 0 0 1 0 12.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
            hash: `<svg ${attrs} fill="none"><path d="M9.3 4.5 7.8 19.5M16.2 4.5l-1.5 15M4.75 9h14.5M4.25 15h14.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
            close: `<svg ${attrs} fill="none"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
        };
        return icons[name] || '';
    }

    channelKindIcon(kind, extraClass = '') {
        return this.normalizeChannelKind(kind) === 'voice'
            ? this.uiIcon('speaker', extraClass)
            : this.uiIcon('hash', extraClass);
    }

    fmtTime(iso) {
        if (!iso) return '';
        try { return new Date(iso).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}); }
        catch(e) { return ''; }
    }

    messageTimestampValue(iso) {
        const ts = Date.parse(iso || '');
        return Number.isFinite(ts) ? ts : 0;
    }

    messageHoverTimeLabel(msg) {
        const iso = msg?.timestamp || '';
        const time = this.fmtTime(iso);
        if (!time) return '';
        const date = this.fmtDate(iso);
        return date ? `${date}, ${time}` : time;
    }

    messageInlineTimeLabel(msg) {
        return this.fmtTime(msg?.timestamp || '');
    }

    conversationLastMessageAt(peer) {
        const msgs = Array.isArray(this.S.chats?.[peer]) ? this.S.chats[peer] : [];
        let lastTs = 0;
        for (const msg of msgs) {
            const ts = this.messageTimestampValue(msg?.timestamp);
            if (ts > lastTs) lastTs = ts;
        }
        return lastTs;
    }

    fmtDate(iso) {
        if (!iso) return '';
        try {
            const messageDate = new Date(iso), now = new Date();
            const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
            if (messageDate.toDateString() === now.toDateString())       return 'Сегодня';
            if (messageDate.toDateString() === yesterday.toDateString()) return 'Вчера';
            return messageDate.toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
        } catch(e) { return ''; }
    }

    nativeBridge() {
        return window.__ZALI_NATIVE || null;
    }

    hasNativeBridge() {
        return !!this.nativeBridge()?.available;
    }

    nativeSupports(capability) {
        return !!this.nativeBridge()?.supports?.[capability];
    }

    setKey(key) {
        if (this.bus?.send) {
            return this.bus.send('zali_styler:set_key', key);
        }
        return false;
    }

    isWindowsNativeAuth() {
        const transport = this.nativeBridge()?.transport;
        return transport === 'ipc' || transport === 'webview2';
    }

    hasNativeAvatarBridge() {
        const transport = this.nativeBridge()?.transport;
        return transport === 'ipc' || transport === 'webview2' || transport === 'webkit';
    }

    startEnergyAwareMaintenance() {
        if (!this.energyMaintenanceBound) {
            this.energyMaintenanceBound = true;
            const onVisibilityChange = () => {
                if (document.hidden) {
                    this.stopVoiceMeterLoop();
                    return;
                }
                this.refreshVisibleAvatars();
                this.syncActiveConversation({ force: !this.nativeSupports('sendMessage') });
                if (this.voice.roomId || this.voice.localStream || this.voice.peerConnections.size > 0) {
                    this.ensureVoiceMeterLoop();
                }
            };
            document.addEventListener('visibilitychange', onVisibilityChange);
            window.addEventListener('focus', onVisibilityChange);
            // Debounced message-cache saves must land before the page goes away.
            window.addEventListener('pagehide', () => this.flushPendingMessageCacheSave());
            window.addEventListener('beforeunload', () => this.flushPendingMessageCacheSave());
        }

        this.scheduleAvatarRefreshPolling();
        this.scheduleConversationSyncPolling();
    }

    scheduleAvatarRefreshPolling() {
        if (this.avatarRefreshTimer) {
            clearTimeout(this.avatarRefreshTimer);
            this.avatarRefreshTimer = null;
        }

        const delay = document.hidden ? 60 * 60 * 1000 : 15 * 60 * 1000;
        this.avatarRefreshTimer = setTimeout(() => {
            this.avatarRefreshTimer = null;
            if (!document.hidden) {
                this.refreshVisibleAvatars();
            }
            this.scheduleAvatarRefreshPolling();
        }, delay);
    }

    scheduleConversationSyncPolling() {
        if (this.messageSyncTimer) {
            clearTimeout(this.messageSyncTimer);
            this.messageSyncTimer = null;
        }

        const hasNativeWs = this.nativeSupports('sendMessage');
        const delay = document.hidden || hasNativeWs ? 5 * 60 * 1000 : 15 * 1000;
        this.messageSyncTimer = setTimeout(() => {
            this.messageSyncTimer = null;
            this.syncActiveConversation({ force: !document.hidden && !hasNativeWs });
            this.scheduleConversationSyncPolling();
        }, delay);
    }

    postNativeMessage(payload) {
        const bridge = this.nativeBridge();
        if (!bridge || typeof bridge.postMessage !== 'function') return false;
        if (!this.validateNativePayload(payload)) return false;
        return !!bridge.postMessage(payload);
    }

    validateNativePayload(payload) {
        if (!payload || typeof payload !== 'object') {
            console.error('[bridge] Invalid native payload:', payload);
            return false;
        }

        const type = String(payload.type || '').trim();
        if (!type) {
            console.error('[bridge] Native payload missing type:', payload);
            return false;
        }

        if (!this.bridgeProtocol) {
            return true;
        }

        const schema = this.bridgeProtocol?.messages?.[type];
        if (!schema) {
            console.error('[bridge] Unknown native message type:', type);
            return false;
        }

        const fields = Array.isArray(schema.fields) ? schema.fields : [];
        if (fields.length > 0 && typeof console !== 'undefined' && console.warn) {
            const missing = fields.filter((field) => !(field in payload));
            if (missing.length > 0) {
                console.warn('[bridge] Missing fields for', type, ':', missing);
            }
        }

        return true;
    }

    trace(message) {
        try {
            console.log(`[ZALI][WEB] ${message}`);
        } catch (e) {}
    }

    // Per-call correlation ID for apiFetch — logged locally and sent as the
    // X-Request-ID header, which the server echoes back and tags every one of
    // its own log lines for that request with. `grep request_id=<id>` across
    // both the browser console and the server log then shows one request's
    // entire lifecycle end to end, instead of guessing which server-side log
    // line matches which client-side action.
    newRequestId() {
        return (window.crypto && window.crypto.randomUUID)
            ? window.crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    nowMs() {
        return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }

    async timeStage(label, fn) {
        const t0 = this.nowMs();
        try {
            return await fn();
        } finally {
            const ms = Math.round(this.nowMs() - t0);
            this.addLogEntry({ type: ms > 1500 ? 'WARN' : 'INFO', msg: `⏱ ${label}: ${ms} мс`, ts: new Date().toLocaleTimeString() });
        }
    }

    myName() {
        return this.S.session?.username || '';
    }

    requestMessagesScroll(position = 'bottom') {
        this.pendingMessagesScroll = position === 'top' ? 'top' : 'bottom';
    }

    resetMessageWindow() {
        this.messageWindow = {
            conversationKey: '',
            start: 0,
            end: 0,
            count: 0,
            useWindow: false,
            avgHeight: this.messageWindow?.avgHeight || 92,
        };
    }

    scheduleMessagesRender() {
        this.scheduleRenderMessages();
    }

    onMessagesScroll() {
        const box = document.getElementById('msgs');
        if (!box) return;
        this.pendingMessagesScroll = null;
        if (this.messageScrollRaf) return;
        this.messageScrollRaf = requestAnimationFrame(() => {
            this.messageScrollRaf = 0;
            const msgs = this.getCurrentMessages();
            const conversationKey = this.S.navMode === 'servers'
                ? this.currentServerChatKey()
                : String(this.S.current || '').trim();
            const nextWindow = this.computeMessageWindow(msgs, box, {
                conversationChanged: conversationKey !== (this.messageWindow?.conversationKey || ''),
                stickToBottom: this.isMessagesNearBottom(box),
            });
            const current = this.messageWindow || {};
            if (
                current.conversationKey === conversationKey &&
                current.start === nextWindow.start &&
                current.end === nextWindow.end &&
                current.count === msgs.length &&
                (!!current.useWindow) === (!!nextWindow.useWindow)
            ) {
                return;
            }
            this.scheduleRenderMessages();
        });
    }

    computeMessageWindow(msgs, box, { conversationChanged = false, stickToBottom = false } = {}) {
        const total = Array.isArray(msgs) ? msgs.length : 0;
        const baseAvg = Math.max(56, Math.min(160, Number(this.messageWindow?.avgHeight || 92)));
        if (total <= 180 || !box) {
            return {
                useWindow: false,
                start: 0,
                end: total,
                topSpacer: 0,
                bottomSpacer: 0,
                avgHeight: baseAvg,
            };
        }

        const viewportCount = Math.max(18, Math.ceil(Math.max(1, box.clientHeight) / baseAvg) + 8);
        const overscan = Math.max(30, Math.floor(viewportCount * 0.7));
        const windowSize = Math.min(total, viewportCount + overscan * 2);
        const nearTop = box.scrollTop <= baseAvg * 4;
        const nearBottom = this.isMessagesNearBottom(box, baseAvg * 2);

        let start = Math.max(0, Math.floor(box.scrollTop / baseAvg) - overscan);
        let end = Math.min(total, start + windowSize);

        if (conversationChanged || stickToBottom || nearBottom) {
            start = Math.max(0, total - windowSize);
            end = total;
        } else if (nearTop) {
            start = 0;
            end = Math.min(total, windowSize);
        }

        if (end - start < windowSize) {
            if (start === 0) {
                end = Math.min(total, windowSize);
            } else if (end === total) {
                start = Math.max(0, total - windowSize);
            }
        }

        return {
            useWindow: true,
            start,
            end,
            topSpacer: start * baseAvg,
            bottomSpacer: Math.max(0, (total - end) * baseAvg),
            avgHeight: baseAvg,
        };
    }

    mobileLayoutQuery() {
        if (!this._mobileLayoutQuery && typeof window.matchMedia === 'function') {
            this._mobileLayoutQuery = window.matchMedia('(max-width: 760px)');
        }
        return this._mobileLayoutQuery || null;
    }

    isMobileLayout() {
        if (typeof window.matchMedia === 'function') {
            return window.matchMedia('(max-width: 760px)').matches;
        }
        return !!this.mobileLayoutQuery()?.matches;
    }

    setMobileSidebarOpen(open) {
        const isOpen = !!open;
        document.body?.classList.toggle('mobile-sidebar-open', isOpen);
        const btn = document.getElementById('mobileMenuBtn');
        if (btn) btn.setAttribute('aria-expanded', String(isOpen));
        const backdrop = document.getElementById('mobileBackdrop');
        if (backdrop) backdrop.hidden = !isOpen;
        return isOpen;
    }

    syncMobileChrome() {
        const isMobile = this.isMobileLayout();
        document.body?.classList.toggle('is-mobile-layout', isMobile);

        const dock = document.getElementById('mobileDock');
        if (dock) {
            dock.classList.toggle('visible', isMobile);
        }

        const settingsActive = !!document.getElementById('viewSettings')?.classList.contains('active');
        const hubActive = !!document.getElementById('viewHub')?.classList.contains('active');
        const chatsBtn = document.getElementById('mobileChatsBtn');
        const serversBtn = document.getElementById('mobileServersBtn');
        const hubBtn = document.getElementById('mobileHubBtn');
        const settingsBtn = document.getElementById('mobileSettingsBtn');

        if (chatsBtn) chatsBtn.classList.toggle('active', !settingsActive && !hubActive && this.S.navMode !== 'servers');
        if (serversBtn) serversBtn.classList.toggle('active', !settingsActive && !hubActive && this.S.navMode === 'servers');
        if (hubBtn) hubBtn.classList.toggle('active', hubActive);
        if (settingsBtn) settingsBtn.classList.toggle('active', settingsActive);

        const mobileMenuBtn = document.getElementById('mobileMenuBtn');
        if (mobileMenuBtn) {
            mobileMenuBtn.classList.toggle('active', !!document.body?.classList.contains('mobile-sidebar-open'));
        }

        const backdrop = document.getElementById('mobileBackdrop');
        if (backdrop) backdrop.hidden = !(isMobile && document.body?.classList.contains('mobile-sidebar-open'));
    }

    closeMobileSidebar() {
        this.setMobileSidebarOpen(false);
    }

    openMobileSidebar() {
        this.setMobileSidebarOpen(true);
    }

    toggleMobileSidebar(force = null) {
        const next = force == null ? !document.body?.classList.contains('mobile-sidebar-open') : !!force;
        return this.setMobileSidebarOpen(next);
    }

    openChatView() {
        const cv = document.getElementById('viewChat');
        const hv = document.getElementById('viewHub');
        const sv = document.getElementById('viewSettings');
        if (sv) sv.classList.remove('active');
        if (hv) hv.classList.remove('active');
        if (cv) cv.classList.add('active');
        this.closeMobileSidebar();
        this.renderServerToolbar();
        this.renderHubSegmentNav();
        this.syncMobileChrome();
    }

    openSettingsView() {
        const cv = document.getElementById('viewChat');
        const hv = document.getElementById('viewHub');
        const sv = document.getElementById('viewSettings');
        if (cv) cv.classList.remove('active');
        if (hv) hv.classList.remove('active');
        if (sv) sv.classList.add('active');
        const tbChat = document.getElementById('tbChat');
        if (tbChat) tbChat.textContent = 'Настройки';
        this.applyNetworkConfigToInputs();
        this.renderUiV2Settings();
        this.renderRecentAccounts();
        this.renderVaultCloudSyncControls();
        this.closeMobileSidebar();
        this.renderHubSegmentNav();
        this.syncMobileChrome();
    }

    openHubView() {
        const cv = document.getElementById('viewChat');
        const hv = document.getElementById('viewHub');
        const sv = document.getElementById('viewSettings');
        if (cv) cv.classList.remove('active');
        if (sv) sv.classList.remove('active');
        if (hv) hv.classList.add('active');
        const tbChat = document.getElementById('tbChat');
        if (tbChat) tbChat.textContent = 'Хаб';
        this.closeMobileSidebar();
        this.renderHub();
        this.renderHubSegmentNav();
        this.syncMobileChrome();
    }

    applyPendingMessagesScroll(box) {
        if (!box || !this.pendingMessagesScroll) return;
        const target = this.pendingMessagesScroll;
        this.pendingMessagesScroll = null;
        if (target === 'bottom') {
            void box.offsetHeight;
            box.scrollTop = box.scrollHeight;
        } else {
            box.scrollTop = 0;
        }
    }

    captureMessageScrollAnchor(box) {
        if (!box) return null;
        const boxRect = box.getBoundingClientRect?.();
        if (!boxRect) return null;
        const nodes = Array.from(box.querySelectorAll('.msg[data-message-id]'));
        for (const node of nodes) {
            const messageId = String(node.dataset?.messageId || '').trim();
            if (!messageId) continue;
            const rect = node.getBoundingClientRect?.();
            if (!rect || rect.bottom < boxRect.top) continue;
            if (rect.top > boxRect.bottom) break;
            return {
                messageId,
                topOffset: rect.top - boxRect.top,
            };
        }
        return null;
    }

    restoreMessageScrollAnchor(box, anchor) {
        if (!box || !anchor?.messageId) return false;
        const nodes = Array.from(box.querySelectorAll('.msg[data-message-id]'));
        const node = nodes.find(item => String(item.dataset?.messageId || '').trim() === anchor.messageId);
        if (!node) return false;
        const boxRect = box.getBoundingClientRect?.();
        const rect = node.getBoundingClientRect?.();
        if (!boxRect || !rect) return false;
        box.scrollTop += (rect.top - boxRect.top) - Number(anchor.topOffset || 0);
        return true;
    }

    isMessagesNearBottom(box, threshold = 56) {
        if (!box) return true;
        return (box.scrollHeight - (box.scrollTop + box.clientHeight)) <= threshold;
    }

    navModeStorageKey() {
        return 'zali_nav_mode_v1';
    }

    uiV2EnabledStorageKey() {
        return 'zali_ui_v2_enabled_v1';
    }

    uiV2SegmentsStorageKey() {
        return 'zali_ui_v2_segments_v1';
    }

    experimentalDesignStorageKey() {
        return 'zali_experimental_design_v1';
    }

    loadExperimentalDesign() {
        try {
            return localStorage.getItem(this.experimentalDesignStorageKey()) === '1';
        } catch (e) {
            return false;
        }
    }

    saveExperimentalDesign(enabled) {
        this.experimentalDesign = !!enabled;
        try {
            localStorage.setItem(this.experimentalDesignStorageKey(), this.experimentalDesign ? '1' : '0');
        } catch (e) {}
        this.applyExperimentalDesign();
    }

    applyExperimentalDesign() {
        document.body?.setAttribute('data-experimental-design', this.experimentalDesign ? 'on' : 'off');
        const toggle = document.getElementById('inputExperimentalDesign');
        if (toggle) toggle.checked = !!this.experimentalDesign;
    }

    hubSegmentCatalog() {
        return [
            { id: 'dm', label: 'ЛС', eyebrow: 'Direct', description: 'Личные диалоги и контакты' },
            { id: 'servers', label: 'Сервера', eyebrow: 'Guilds', description: 'Каналы, роли и сообщества' },
        ];
    }

    loadUiV2Enabled() {
        try {
            return localStorage.getItem(this.uiV2EnabledStorageKey()) === '1';
        } catch (e) {
            return false;
        }
    }

    saveUiV2Enabled(enabled) {
        this.uiV2Enabled = !!enabled;
        try {
            localStorage.setItem(this.uiV2EnabledStorageKey(), this.uiV2Enabled ? '1' : '0');
        } catch (e) {}
        this.applyUiV2Chrome();
    }

    normalizeUiV2Segments(value) {
        const allowed = new Set(this.hubSegmentCatalog().map(item => item.id));
        const source = Array.isArray(value) ? value : [];
        const next = [];
        for (const item of source) {
            const id = String(item || '').trim();
            if (!allowed.has(id) || next.includes(id)) continue;
            next.push(id);
            if (next.length >= 3) break;
        }
        return next.length ? next : ['dm', 'servers'];
    }

    loadUiV2Segments() {
        try {
            const raw = localStorage.getItem(this.uiV2SegmentsStorageKey());
            return this.normalizeUiV2Segments(raw ? JSON.parse(raw) : ['dm', 'servers']);
        } catch (e) {
            return ['dm', 'servers'];
        }
    }

    saveUiV2Segments(segments) {
        this.uiV2Segments = this.normalizeUiV2Segments(segments);
        try {
            localStorage.setItem(this.uiV2SegmentsStorageKey(), JSON.stringify(this.uiV2Segments));
        } catch (e) {}
        this.applyUiV2Chrome();
    }

    activeHubSegmentId() {
        if (document.getElementById('viewHub')?.classList.contains('active')) return 'hub';
        if (document.getElementById('viewSettings')?.classList.contains('active')) return 'settings';
        return this.S.navMode === 'servers' ? 'servers' : 'dm';
    }

    handleHubSegment(segmentId) {
        const id = String(segmentId || '').trim();
        if (id === 'hub') {
            this.openHubView();
            return;
        }
        if (id === 'settings') {
            this.openSettingsView();
            return;
        }
        if (id === 'servers') {
            this.setNavMode('servers', { refresh: true });
            this.openChatView();
            return;
        }
        this.setNavMode('dm', { refresh: true });
        this.openChatView();
    }

    hubSegmentIcon(id) {
        const key = String(id || '').trim();
        const icons = {
            dm: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.25 5.75h13.5a2 2 0 0 1 2 2v7.1a2 2 0 0 1-2 2H11.4l-4.75 3.4v-3.4h-1.4a2 2 0 0 1-2-2v-7.1a2 2 0 0 1 2-2Z"/><path d="M7.4 9.3h9.2M7.4 12.6h6.4"/></svg>',
            servers: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.2 4.6h11.6a2 2 0 0 1 2 2v2.8a2 2 0 0 1-2 2H6.2a2 2 0 0 1-2-2V6.6a2 2 0 0 1 2-2Z"/><path d="M6.2 12.6h11.6a2 2 0 0 1 2 2v2.8a2 2 0 0 1-2 2H6.2a2 2 0 0 1-2-2v-2.8a2 2 0 0 1 2-2Z"/><path d="M7.6 8h.05M7.6 16h.05M10.4 8h6M10.4 16h6"/></svg>',
            settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h8.2"/><path d="M16.8 7H19"/><path d="M15 5.1a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z"/><path d="M5 17h2.2"/><path d="M10.8 17H19"/><path d="M9 15.1a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z"/><path d="M5 12h4.2"/><path d="M12.8 12H19"/><path d="M11 10.1a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z"/></svg>',
            hub: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.75 20.25 9v9.25a2 2 0 0 1-2 2h-4.1v-5.35h-4.3v5.35h-4.1a2 2 0 0 1-2-2V9L12 3.75Z"/></svg>',
        };
        return icons[key] || icons.hub;
    }

    renderHubSegmentNav() {
        const nav = document.getElementById('hubSegmentNav');
        if (!nav) return;
        const catalog = new Map(this.hubSegmentCatalog().map(item => [item.id, item]));
        const active = this.activeHubSegmentId();
        const items = this.normalizeUiV2Segments(this.uiV2Segments)
            .map(id => catalog.get(id))
            .filter(Boolean);
        items.push({ id: 'hub', label: 'Хаб', eyebrow: 'Home', description: 'Новости и подприложения' });
        const signature = items.map(item => item.id).join('|');
        const hasStableButtons = nav.dataset.segmentSignature === signature
            && nav.querySelector('.hub-segment-indicator')
            && nav.querySelectorAll('.hub-segment-btn').length === items.length;
        if (hasStableButtons) {
            this.updateHubSegmentNavActive(active);
            return;
        }
        nav.innerHTML = '<span class="hub-segment-indicator" aria-hidden="true"></span>' + items.map(item => `
            <button class="hub-segment-btn ${active === item.id ? 'active' : ''}" type="button" data-hub-segment="${this.esc(item.id)}" title="${this.esc(item.label)} · ${this.esc(item.description)}" aria-label="${this.esc(item.label)}" aria-pressed="${active === item.id ? 'true' : 'false'}">
                ${this.hubSegmentIcon(item.id)}
            </button>
        `).join('');
        nav.dataset.segmentSignature = signature;
        this.syncHubSegmentIndicator(null);
    }

    updateHubSegmentNavActive(active) {
        const nav = document.getElementById('hubSegmentNav');
        if (!nav) return;
        const previousActive = nav.querySelector('.hub-segment-btn.active');
        const previousPosition = previousActive
            ? {
                x: previousActive.offsetLeft,
                width: previousActive.offsetWidth,
            }
            : null;
        nav.querySelectorAll('.hub-segment-btn').forEach(btn => {
            const isActive = String(btn.getAttribute('data-hub-segment') || '') === active;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', String(isActive));
        });
        this.syncHubSegmentIndicator(previousPosition);
    }

    syncHubSegmentIndicator(previousPosition = null) {
        const nav = document.getElementById('hubSegmentNav');
        const indicator = nav?.querySelector('.hub-segment-indicator');
        const activeBtn = nav?.querySelector('.hub-segment-btn.active');
        if (!nav || !indicator || !activeBtn) return;
        const applyTarget = (withTransition = true) => {
            if (withTransition) indicator.style.transition = '';
            indicator.style.width = `${activeBtn.offsetWidth}px`;
            indicator.style.transform = `translate3d(${activeBtn.offsetLeft}px, 0, 0)`;
        };
        const samePosition = previousPosition
            && Math.abs(Number(previousPosition.x || 0) - activeBtn.offsetLeft) < 0.5
            && Math.abs(Number(previousPosition.width || 0) - activeBtn.offsetWidth) < 0.5;
        if (samePosition) {
            return;
        }
        if (previousPosition) {
            indicator.getBoundingClientRect();
            requestAnimationFrame(() => applyTarget(true));
        } else {
            indicator.style.transition = 'none';
            applyTarget(false);
            requestAnimationFrame(() => {
                indicator.style.transition = '';
            });
        }
    }

    renderUiV2Settings() {
        const toggle = document.getElementById('inputUiV2Enabled');
        if (toggle) toggle.checked = !!this.uiV2Enabled;
        const box = document.getElementById('hubSegmentSettings');
        const count = document.getElementById('hubSegmentsCount');
        if (!box) return;
        const selected = new Set(this.normalizeUiV2Segments(this.uiV2Segments));
        const total = selected.size + 1;
        if (count) count.textContent = `${total} / 4`;
        box.innerHTML = this.hubSegmentCatalog().map(item => `
            <label class="hub-segment-option">
                <input type="checkbox" value="${this.esc(item.id)}" ${selected.has(item.id) ? 'checked' : ''}>
                <span>
                    <strong>${this.esc(item.label)}</strong>
                    <small>${this.esc(item.description)}</small>
                </span>
            </label>
        `).join('');
    }

    applyUiV2Chrome() {
        document.body?.setAttribute('data-ui-v2', this.uiV2Enabled ? 'on' : 'off');
        if (!this.uiV2Enabled && document.getElementById('viewHub')?.classList.contains('active')) {
            this.openChatView();
        }
        this.renderHubSegmentNav();
        this.renderUiV2Settings();
        this.syncMobileChrome();
    }

    _userSuffix() {
        const u = this.S.session?.username;
        return u ? `_${u}` : '';
    }

    activeServerStorageKey() {
        return `zali_active_server_v1${this._userSuffix()}`;
    }

    activeChannelStorageKey() {
        return `zali_active_channel_v1${this._userSuffix()}`;
    }

    currentContactStorageKey() {
        return `zali_current_contact_v1${this._userSuffix()}`;
    }

    contactsStorageKey() {
        return `zali_contacts_v1${this._userSuffix()}`;
    }

    serverChatsStorageKey() {
        return `zali_server_chats_v1${this._userSuffix()}`;
    }

    mutedChatsStorageKey() {
        return `zali_muted_chats_v1${this._userSuffix()}`;
    }

    messageCacheStorageKey() {
        return `zali_message_cache_v1${this._userSuffix()}`;
    }

    networkConfigStorageKey() {
        return 'zali_network_config_v1';
    }

    cryptoKeyStorageKey() {
        return `zali_crypto_key_v2${this._userSuffix()}`;
    }

    deviceIdentityStorageKey() {
        return `zali_device_identity_v1${this._userSuffix()}`;
    }

    authStorageKey() {
        return 'zali_session_v1';
    }

    lastAuthStorageKey() {
        return 'zali_last_session_v1';
    }

    recentAccountsStorageKey() {
        return 'zali_recent_accounts_v1';
    }

    pendingOutboxStorageKey() {
        return `zali_pending_outbox_v1${this._userSuffix()}`;
    }

    loadStoredMessageCache() {
        try {
            // Deliberately does NOT fall back to the old unsuffixed 'zali_message_cache_v1'
            // key: that was a one-time migration for the pre-per-account-storage era, but
            // left active it means every brand-new account's first load silently adopts
            // whatever chats a DIFFERENT previous account left behind on this browser —
            // "ghost" conversations with people this account never talked to. Same reasoning
            // applies to the crypto key / conversation keys / device identity loaders below.
            let raw = localStorage.getItem(this.messageCacheStorageKey());
            if (!raw) return this.loadInjectedMessageCache();
            const parsed = JSON.parse(raw);
            const chats = parsed && typeof parsed === 'object' && parsed.chats && typeof parsed.chats === 'object'
                ? parsed.chats
                : {};
            const serverChats = parsed && typeof parsed === 'object' && parsed.serverChats && typeof parsed.serverChats === 'object'
                ? parsed.serverChats
                : {};
            if (!Object.keys(chats).length && !Object.keys(serverChats).length) {
                return this.loadInjectedMessageCache();
            }
            return {
                chats: Object.fromEntries(Object.entries(chats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
                serverChats: Object.fromEntries(Object.entries(serverChats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
            };
        } catch (e) {
            return this.loadInjectedMessageCache();
        }
    }

    loadInjectedMessageCache() {
        try {
            const raw = window.__ZALI_MESSAGE_CACHE;
            if (!raw) return { chats: {}, serverChats: {} };
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!parsed || typeof parsed !== 'object') return { chats: {}, serverChats: {} };
            const chats = parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {};
            const serverChats = parsed.serverChats && typeof parsed.serverChats === 'object' ? parsed.serverChats : {};
            return {
                chats: Object.fromEntries(Object.entries(chats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
                serverChats: Object.fromEntries(Object.entries(serverChats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
            };
        } catch (e) {
            return { chats: {}, serverChats: {} };
        }
    }

    // Debounced wrapper for saveStoredMessageCache(). The full save serializes EVERY
    // chat (JSON.stringify of the whole store), writes localStorage AND ships the whole
    // payload over the native bridge — doing that once per received message made bursts
    // (history merge, reconnect catch-up, busy group chat) quadratic in total work.
    // Trailing-edge coalesce: bursts collapse into one save ≤400ms after the first call.
    scheduleSaveStoredMessageCache(delayMs = 400) {
        if (this._messageCacheSaveTimer) return;
        this._messageCacheSaveTimer = setTimeout(() => {
            this._messageCacheSaveTimer = null;
            this.saveStoredMessageCache();
        }, Math.max(0, Number(delayMs) || 0));
    }

    // Flush a pending debounced save immediately (page hide, logout, account switch) so
    // the last ≤400ms of messages are never lost to a teardown racing the timer.
    flushPendingMessageCacheSave() {
        if (!this._messageCacheSaveTimer) return;
        clearTimeout(this._messageCacheSaveTimer);
        this._messageCacheSaveTimer = null;
        this.saveStoredMessageCache();
    }

    saveStoredMessageCache() {
        const sanitizeMessages = (store) => Object.fromEntries(Object.entries(store || {}).map(([key, msgs]) => [
            key,
            Array.isArray(msgs) ? msgs.map(msg => ({
                ...msg,
                attachments: this.normalizeAttachments(msg.attachments).map(att => ({
                    id: att.id,
                    name: att.name,
                    mimeType: att.mimeType,
                    kind: att.kind,
                    size: att.size,
                    archivePath: att.archivePath,
                })),
            })) : [],
        ]));
        const payload = {
            chats: sanitizeMessages(this.S.chats),
            serverChats: sanitizeMessages(this.S.serverChats),
        };
        const json = JSON.stringify(payload);
        try {
            localStorage.setItem(this.messageCacheStorageKey(), json);
        } catch (e) {
            this.trace(`saveStoredMessageCache localStorage failed reason=${e?.name || e?.message || e}`);
            this.warnStorageFallback('message_cache', `Не удалось сохранить кеш сообщений в localStorage: ${e?.name || e?.message || e}`);
        }
        this.saveInjectedMessageCache(json);
        if (this.nativeSupports('saveMessageCache')) {
            this.postNativeMessage({
                type: NativeMessageTypes.SAVE_MESSAGE_CACHE,
                cache: payload,
            });
        }
    }

    saveInjectedMessageCache(value) {
        try {
            window.__ZALI_MESSAGE_CACHE = typeof value === 'string' ? value : JSON.stringify(value || { chats: {}, serverChats: {} });
        } catch (e) {}
    }

    normalizeDmChatStore() {
        const me = String(this.myName() || '').trim();
        if (!me) return false;

        const normalized = {};
        let changed = false;

        const pushMessage = (peer, msg, originalKey) => {
            const nextPeer = String(peer || '').trim();
            if (!nextPeer) return;
            if (!normalized[nextPeer]) normalized[nextPeer] = [];
            normalized[nextPeer].push(msg);
            if (String(originalKey || '').trim() !== nextPeer) {
                changed = true;
            }
        };

        Object.entries(this.S.chats || {}).forEach(([key, msgs]) => {
            if (!Array.isArray(msgs)) return;
            msgs.forEach(msg => {
                if (!msg || typeof msg !== 'object') return;
                const sender = String(msg.sender || '').trim();
                const receiver = String(msg.receiver || '').trim();
                const canonicalPeer = sender === me
                    ? receiver
                    : (receiver === me ? sender : '');

                if (canonicalPeer) {
                    pushMessage(canonicalPeer, msg, key);
                } else {
                    pushMessage(String(key || '').trim(), msg, key);
                }
            });
        });

        Object.keys(normalized).forEach(peer => {
            normalized[peer].sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
        });

        const before = JSON.stringify(this.S.chats || {});
        const after = JSON.stringify(normalized);
        if (before !== after) {
            this.S.chats = normalized;
            this.saveStoredMessageCache();
            this.trace(`normalizeDmChatStore changed peers=${Object.keys(normalized).length}`);
            return true;
        }

        this.S.chats = normalized;
        return changed;
    }

    loadStoredCurrentContact() {
        try {
            const raw = localStorage.getItem(this.currentContactStorageKey());
            const value = String(raw || '').trim();
            return value || null;
        } catch (e) {
            return null;
        }
    }

    saveStoredCurrentContact(name) {
        try {
            const value = String(name || '').trim();
            if (value) {
                localStorage.setItem(this.currentContactStorageKey(), value);
            } else {
                localStorage.removeItem(this.currentContactStorageKey());
            }
        } catch (e) {}
    }

    loadStoredContacts() {
        try {
            const raw = localStorage.getItem(this.contactsStorageKey());
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed)
                ? parsed.map(item => String(item || '').trim()).filter(Boolean)
                : [];
        } catch (e) {
            return [];
        }
    }

    saveStoredContacts(contacts) {
        try {
            const list = Array.isArray(contacts)
                ? contacts.map(item => String(item || '').trim()).filter(Boolean)
                : [];
            localStorage.setItem(this.contactsStorageKey(), JSON.stringify(list));
        } catch (e) {}
    }

    localConversationContacts() {
        const me = String(this.myName() || '').trim();
        const names = new Set();
        const add = (name) => {
            const value = String(name || '').trim();
            if (value && value !== me) names.add(value);
        };
        Object.entries(this.S.chats || {}).forEach(([peer, msgs]) => {
            if (Array.isArray(msgs) && msgs.length > 0) add(peer);
        });
        add(this.S.current);
        add(this.loadStoredCurrentContact());
        return Array.from(names);
    }

    loadStoredCryptoKey() {
        try {
            const scope = String(this.activeConversationScope || window.__ZALI_ACTIVE_CONVERSATION_SCOPE || '').trim();
            if (scope) {
                const scoped = this.getStoredConversationKey(scope);
                if (scoped) return scoped;
            }
            // No fallback to the legacy unsuffixed 'zali_crypto_key_v2' key — see the
            // comment in loadStoredMessageCache() for why: it would hand a brand-new
            // account a previous, unrelated account's leftover E2E key.
            let stored = (sessionStorage.getItem(this.cryptoKeyStorageKey()) || localStorage.getItem(this.cryptoKeyStorageKey()) || '').trim();
            this.trace(`loadStoredCryptoKey stored=${!!stored}`);
            if (stored) {
                try {
                    sessionStorage.setItem(this.cryptoKeyStorageKey(), stored);
                    localStorage.removeItem(this.cryptoKeyStorageKey());
                } catch (e) {}
                return stored;
            }
            return '';
        } catch (e) {
            this.trace('loadStoredCryptoKey error fallback empty');
            return '';
        }
    }

    conversationKeysStorageKey() {
        return `zali_conversation_keys_v2${this._userSuffix()}`;
    }

    cloudVaultSnapshotStorageKey() {
        return `zali_cloud_vault_snapshot_v2${this._userSuffix()}`;
    }

    vaultUnlockStorageKey() {
        return `zali_vault_unlock_v2${this._userSuffix()}`;
    }

    keyMaterialEpochStorageKey() {
        return `zali_key_material_epoch${this._userSuffix()}`;
    }

    vaultResetPendingStorageKey() {
        return `zali_vault_reset_pending_v2${this._userSuffix()}`;
    }

    vaultCloudSyncEnabledStorageKey() {
        return `zali_vault_cloud_sync_enabled_v1${this._userSuffix()}`;
    }

    loadVaultCloudSyncEnabled() {
        try {
            const raw = localStorage.getItem(this.vaultCloudSyncEnabledStorageKey());
            if (raw == null) return false;
            return String(raw).trim().toLowerCase() !== 'false';
        } catch (e) {
            return false;
        }
    }

    saveVaultCloudSyncEnabled(enabled) {
        try {
            localStorage.setItem(this.vaultCloudSyncEnabledStorageKey(), enabled ? 'true' : 'false');
        } catch (e) {}
    }

    applyVaultCloudSyncEnabled(enabled, { persistLocal = true } = {}) {
        const next = !!enabled;
        this.S.auth.cloudVaultSyncEnabled = next;
        if (persistLocal) {
            this.saveVaultCloudSyncEnabled(next);
        }
        this.renderVaultCloudSyncControls();
        this.updateAuthView();
    }

    isVaultCloudSyncEnabled() {
        return !!this.S.auth?.cloudVaultSyncEnabled;
    }

    async saveAccountVaultCloudSyncEnabled(enabled) {
        if (!this.S.session?.token) return false;
        try {
            const res = await this.apiFetch(this.apiRoutes.auth.me, {
                method: 'PATCH',
                body: JSON.stringify({ cloudVaultSyncEnabled: !!enabled }),
            });
            if (!res.ok) {
                throw new Error(await res.text().catch(() => 'Не удалось сохранить настройку'));
            }
            const data = await res.json().catch(() => null);
            if (data && typeof data.cloudVaultSyncEnabled !== 'undefined') {
                this.applyVaultCloudSyncEnabled(!!data.cloudVaultSyncEnabled, { persistLocal: true });
            }
            return true;
        } catch (e) {
            this.trace(`saveAccountVaultCloudSyncEnabled failed error=${e?.message || e}`);
            this.S.auth.error = e?.message || 'Не удалось сохранить настройку облачной синхронизации ключей';
            this.updateAuthView();
            return false;
        }
    }

    async setVaultCloudSyncEnabled(enabled) {
        const next = !!enabled;
        const previous = this.isVaultCloudSyncEnabled();
        this.applyVaultCloudSyncEnabled(next, { persistLocal: true });
        if (this.S.session?.token) {
            const ok = await this.saveAccountVaultCloudSyncEnabled(next);
            if (!ok) {
                this.applyVaultCloudSyncEnabled(previous, { persistLocal: true });
                return;
            }
        }
        if (this.cloudVaultSyncTimer) {
            clearTimeout(this.cloudVaultSyncTimer);
            this.cloudVaultSyncTimer = 0;
        }
        if (this.S.auth.cloudVaultSyncEnabled && this.S.session?.token && this.S.auth?.vaultPassphrase) {
            void this.syncCloudVaultPackage({ passphrase: this.S.auth.vaultPassphrase, reason: 'vault-sync-enabled' });
        }
    }

    renderVaultCloudSyncControls() {
        const checkbox = document.getElementById('inputVaultCloudSyncEnabled');
        if (checkbox) {
            checkbox.checked = this.isVaultCloudSyncEnabled();
        }
    }

    conversationScopeKey(peer = null, serverId = null, channelId = null) {
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        if (sid && cid) {
            return `server:${sid}:${cid}`;
        }
        const me = String(this.myName() || '').trim();
        const other = String(peer || this.S.current || '').trim();
        if (!me || !other) return '';
        return `dm:${[me, other].sort().join(':')}`;
    }

    dmScopeOwner(scope) {
        // For a DM scope `dm:a:b` (participants sorted), the lexicographically
        // smaller participant is the canonical owner of the conversation key.
        const parts = String(scope || '').split(':');
        if (parts[0] !== 'dm') return '';
        return String(parts[1] || '').trim();
    }

    addAltConversationKey(stored, scope, key) {
        // Store a non-active conversation key so it still appears in the candidate
        // pool used for decryption (native tries every value of the keys map), while
        // leaving stored[scope] — the active key used for sending — untouched.
        const value = String(key || '').trim();
        if (!value || !scope) return false;
        if (String(stored[scope] || '').trim() === value) return false;
        // Map key embeds the value, so re-adding the same key is idempotent.
        const altKey = `alt:${scope}:${value}`;
        if (Object.prototype.hasOwnProperty.call(stored, altKey)) return false;
        stored[altKey] = value;
        return true;
    }

    keyEnvelopeOverridesLocal(scope, payload) {
        // Only the canonical owner's envelope may replace an existing local key.
        // The owner always keeps its own key; the non-owner adopts the owner's,
        // so both peers converge on a single key regardless of who generated
        // a key first (otherwise each side keeps its own and decryption fails).
        const owner = this.dmScopeOwner(scope);
        if (!owner) return false;
        const me = String(this.myName() || '').trim();
        const sender = String(payload?.sender || '').trim();
        return sender === owner && me !== owner;
    }

    loadStoredConversationKeys() {
        try {
            // No fallback to the legacy unsuffixed 'zali_conversation_keys_v2' key — see
            // the comment in loadStoredMessageCache() for why: this one is the most
            // severe case, since it would hand a brand-new account every per-DM E2E key
            // a previous, unrelated account on this browser ever had.
            let raw = sessionStorage.getItem(this.conversationKeysStorageKey()) || localStorage.getItem(this.conversationKeysStorageKey());
            const injected = window.__ZALI_CONVERSATION_KEYS && typeof window.__ZALI_CONVERSATION_KEYS === 'object'
                ? window.__ZALI_CONVERSATION_KEYS
                : {};
            if (!raw) return { ...injected };
            const parsed = JSON.parse(raw);
            const merged = { ...injected, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
            try {
                sessionStorage.setItem(this.conversationKeysStorageKey(), JSON.stringify(merged || {}));
                localStorage.removeItem(this.conversationKeysStorageKey());
            } catch (e) {}
            return merged && typeof merged === 'object' ? merged : {};
        } catch (e) {
            return {};
        }
    }

    getStoredConversationKey(scope) {
        const key = String(scope || '').trim();
        if (!key) return '';
        const stored = this.loadStoredConversationKeys();
        return String(stored[key] || '').trim();
    }

    syncNativeConversationKeys(keys = null) {
        if (!this.nativeSupports('setKey')) return;
        const conversationKeys = keys && typeof keys === 'object' ? keys : this.loadStoredConversationKeys();
        const scope = String(window.__ZALI_ACTIVE_CONVERSATION_SCOPE || this.activeConversationScope || '').trim();
        const key = scope
            ? String(conversationKeys[scope] || '').trim()
            : String(sessionStorage.getItem(this.cryptoKeyStorageKey()) || localStorage.getItem(this.cryptoKeyStorageKey()) || '').trim();
        let signature = '';
        try {
            signature = JSON.stringify({
                scope,
                key,
                conversationKeys: Object.keys(conversationKeys || {}).sort().reduce((acc, itemKey) => {
                    acc[itemKey] = String(conversationKeys[itemKey] || '').trim();
                    return acc;
                }, {}),
            });
        } catch (e) {
            signature = `${scope}:${key}:${Object.keys(conversationKeys || {}).length}`;
        }
        if (signature && signature === this.lastNativeConversationKeySignature) {
            return;
        }
        this.lastNativeConversationKeySignature = signature;
        this.postNativeMessage({
            type: NativeMessageTypes.SET_KEY,
            key,
            scope,
            conversationKeys,
        });
    }

    saveStoredConversationKeys(keys) {
        try {
            sessionStorage.setItem(this.conversationKeysStorageKey(), JSON.stringify(keys || {}));
            localStorage.removeItem(this.conversationKeysStorageKey());
            this.syncNativeConversationKeys(keys || {});
            if (this.S.session?.token && this.S.auth?.vaultPassphrase && !this.cloudVaultSyncInFlight) {
                this.scheduleCloudVaultSync(300);
            }
        } catch (e) {}
    }

    clearLegacyKeyMaterial() {
        try {
            if (localStorage.getItem(this.keyMaterialEpochStorageKey()) === '2') return;
            [
                'zali_crypto_key_v1',
                'zali_conversation_keys_v1',
                'zali_cloud_vault_snapshot_v1',
                'zali_vault_unlock_v1',
            ].forEach(key => {
                try { localStorage.removeItem(key); } catch (e) {}
                try { sessionStorage.removeItem(key); } catch (e) {}
            });
            try { window.__ZALI_SAVED_KEY = ''; } catch (e) {}
            try { window.__ZALI_CONVERSATION_KEYS = {}; } catch (e) {}
            localStorage.setItem(this.vaultResetPendingStorageKey(), 'true');
            localStorage.setItem(this.keyMaterialEpochStorageKey(), '2');
            this.trace('clearLegacyKeyMaterial epoch=2 legacy_keys_cleared=true');
        } catch (e) {
            this.trace(`clearLegacyKeyMaterial failed error=${e?.message || e}`);
        }
    }

    async ensureServerVaultReset({ reason = 'auto' } = {}) {
        if (!this.S.session?.token) return false;
        try {
            if (localStorage.getItem(this.vaultResetPendingStorageKey()) !== 'true') return false;
            const res = await this.apiFetch(this.apiRoutes.vault.events, { method: 'DELETE' });
            if (!res.ok) {
                throw new Error(await res.text().catch(() => 'Не удалось очистить server vault'));
            }
            localStorage.removeItem(this.vaultResetPendingStorageKey());
            this.trace(`ensureServerVaultReset reason=${reason} cleared=true`);
            return true;
        } catch (e) {
            this.trace(`ensureServerVaultReset failed reason=${reason} error=${e?.message || e}`);
            return false;
        }
    }

    async encryptCloudVaultSnapshot(payload, secret) {
        const salt = new Uint8Array(16);
        const iv = new Uint8Array(12);
        crypto.getRandomValues(salt);
        crypto.getRandomValues(iv);
        const key = await this.deriveVaultAesKey(secret, salt);
        const plain = new TextEncoder().encode(JSON.stringify(payload || {}));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
        return JSON.stringify({
            v: 1,
            kdf: 'PBKDF2-SHA256',
            iterations: 210000,
            aead: 'AES-256-GCM',
            salt: this.base64FromBytes(salt),
            iv: this.base64FromBytes(iv),
            ciphertext: this.base64FromBytes(ciphertext),
        });
    }

    async decryptCloudVaultSnapshot(packageText, secret) {
        const raw = String(packageText || '').trim();
        if (!raw) return null;
        const envelope = JSON.parse(raw);
        if (envelope.v !== 1) throw new Error('Unsupported vault version');
        if (typeof envelope.iterations === 'number' && envelope.iterations < 100000) {
            throw new Error('Vault KDF iterations too low');
        }
        const salt = this.bytesFromBase64(envelope.salt);
        const iv = this.bytesFromBase64(envelope.iv);
        const ciphertext = this.bytesFromBase64(envelope.ciphertext);
        const key = await this.deriveVaultAesKey(secret, salt);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return JSON.parse(new TextDecoder().decode(new Uint8Array(plain)));
    }

    async saveCloudVaultSnapshot(payload, secret = null) {
        const token = String(secret || this.S.session?.token || '').trim();
        if (!token || !payload || typeof payload !== 'object') return false;
        try {
            const encrypted = await this.encryptCloudVaultSnapshot(payload, token);
            localStorage.setItem(this.cloudVaultSnapshotStorageKey(), encrypted);
            this._vaultSnapshotApplied = false; // invalidate cache so next restore re-decrypts
            return true;
        } catch (e) {
            this.trace(`saveCloudVaultSnapshot error=${e?.message || e}`);
            return false;
        }
    }

    async encryptVaultUnlockSecret(secret, token) {
        const passphrase = String(secret || '').trim();
        const guard = String(token || '').trim();
        if (!passphrase || !guard) return '';
        const salt = new Uint8Array(16);
        const iv = new Uint8Array(12);
        crypto.getRandomValues(salt);
        crypto.getRandomValues(iv);
        const key = await this.deriveVaultAesKey(guard, salt);
        const plain = new TextEncoder().encode(passphrase);
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
        return JSON.stringify({
            v: 1,
            kdf: 'PBKDF2-SHA256',
            iterations: 210000,
            aead: 'AES-256-GCM',
            salt: this.base64FromBytes(salt),
            iv: this.base64FromBytes(iv),
            ciphertext: this.base64FromBytes(ciphertext),
        });
    }

    async decryptVaultUnlockSecret(raw, token) {
        const guard = String(token || '').trim();
        const encoded = String(raw || '').trim();
        if (!guard || !encoded) return '';
        const envelope = JSON.parse(encoded);
        if (envelope.v !== 1) throw new Error('Unsupported vault version');
        if (typeof envelope.iterations === 'number' && envelope.iterations < 100000) {
            throw new Error('Vault KDF iterations too low');
        }
        const salt = this.bytesFromBase64(envelope.salt);
        const iv = this.bytesFromBase64(envelope.iv);
        const ciphertext = this.bytesFromBase64(envelope.ciphertext);
        const key = await this.deriveVaultAesKey(guard, salt);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return new TextDecoder().decode(new Uint8Array(plain)).trim();
    }

    async saveVaultUnlockSecret(secret, token = null) {
        const passphrase = String(secret || '').trim();
        const guard = String(token || this.S.session?.token || '').trim();
        try {
            if (!passphrase || !guard) {
                localStorage.removeItem(this.vaultUnlockStorageKey());
                return false;
            }
            const encrypted = await this.encryptVaultUnlockSecret(passphrase, guard);
            localStorage.setItem(this.vaultUnlockStorageKey(), encrypted);
            return true;
        } catch (e) {
            this.trace(`saveVaultUnlockSecret error=${e?.message || e}`);
            return false;
        }
    }

    async loadVaultUnlockSecret(token = null) {
        const guard = String(token || this.S.session?.token || '').trim();
        if (!guard) return '';
        try {
            const raw = localStorage.getItem(this.vaultUnlockStorageKey());
            if (!raw) return '';
            return await this.decryptVaultUnlockSecret(raw, guard);
        } catch (e) {
            this.trace(`loadVaultUnlockSecret error=${e?.message || e}`);
            return '';
        }
    }

    async restoreCloudVaultSnapshot({ reason = 'auto' } = {}) {
        const token = String(this.S.session?.token || '').trim();
        if (!token) return false;
        // Skip if already applied this session (vault snapshot doesn't change until saveCloudVaultSnapshot)
        if (this._vaultSnapshotApplied) return false;
        // Deduplicate concurrent calls — only one PBKDF2 derivation at a time
        if (this._restoreVaultInFlight) return this._restoreVaultInFlight;
        this._restoreVaultInFlight = (async () => {
            try {
                const raw = localStorage.getItem(this.cloudVaultSnapshotStorageKey());
                if (!raw) return false;
                const payload = await this.decryptCloudVaultSnapshot(raw, token);
                const count = this.applyVaultPlainPayload(payload);
                this.trace(`restoreCloudVaultSnapshot reason=${reason} count=${count}`);
                if (count >= 0) this._vaultSnapshotApplied = true;
                return count > 0;
            } catch (e) {
                this.trace(`restoreCloudVaultSnapshot failed reason=${reason} error=${e?.message || e}`);
                return false;
            } finally {
                this._restoreVaultInFlight = null;
            }
        })();
        return this._restoreVaultInFlight;
    }

    async resolveConversationCryptoKey({ peer = null, serverId = null, channelId = null, reason = 'auto' } = {}) {
        const scope = this.conversationScopeKey(peer, serverId, channelId);
        if (!scope) return '';
        if (!this._resolveKeyInFlight) this._resolveKeyInFlight = new Map();
        if (this._resolveKeyInFlight.has(scope)) return this._resolveKeyInFlight.get(scope);
        const promise = this._resolveConversationCryptoKeyImpl({ peer, serverId, channelId, reason });
        this._resolveKeyInFlight.set(scope, promise);
        try { return await promise; } finally { this._resolveKeyInFlight.delete(scope); }
    }

    async _resolveConversationCryptoKeyImpl({ peer = null, serverId = null, channelId = null, reason = 'auto' } = {}) {
        const scope = this.conversationScopeKey(peer, serverId, channelId);
        if (!scope) return '';
        this.activeConversationScope = scope;
        try {
            window.__ZALI_ACTIVE_CONVERSATION_SCOPE = scope;
        } catch (e) {}

        const existing = this.getStoredConversationKey(scope);
        if (existing) {
            this.syncNativeConversationKeys();
            this.updateCryptoKeyDisplay({
                key: existing,
                peer,
                serverId,
                channelId,
            });
            return existing;
        }

        if (this.S.session?.token) {
            const recoveredVaultPassphrase = this.S.auth?.vaultPassphrase || await this.loadVaultUnlockSecret(this.S.session.token);
            if (recoveredVaultPassphrase) {
                this.S.auth.vaultPassphrase = recoveredVaultPassphrase;
                await this.restoreCloudVaultSnapshot({ reason: `resolveConversationCryptoKey:${reason}` });
                // restoreCloudVaultSnapshot читает только локальный кэш — на свежем
                // устройстве он пуст, а фоновый sync из postAuthSetup ещё не успел
                // сходить в облако. Без этого await ключ генерировался временным,
                // хотя настоящий уже лежал в cloud vault (гонка на ~1 секунду).
                if (!this.getStoredConversationKey(scope) && !this._cloudVaultResolveFetchDone) {
                    this._cloudVaultResolveFetchDone = true;
                    await this.syncCloudVaultPackage({ passphrase: recoveredVaultPassphrase, reason: `resolveConversationCryptoKey:${reason}` });
                }
            }
            await this.syncIncomingKeyEnvelopes({ reason: `resolveConversationCryptoKey:${reason}`, triggerRefresh: false });
        }

        const restored = this.getStoredConversationKey(scope);
        if (restored) {
            this.syncNativeConversationKeys();
            this.updateCryptoKeyDisplay({
                key: restored,
                peer,
                serverId,
                channelId,
            });
            return restored;
        }

        const localKey = this.randomBase64(32).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
        const stored = this.loadStoredConversationKeys();
        stored[scope] = localKey;
        this.saveStoredConversationKeys(stored);
        this.setKey(localKey);
        this.trace(`resolveConversationCryptoKey reason=${reason} scope=${scope} generated=true`);
        const owner = this.dmScopeOwner(scope);
        const meName = String(this.myName() || '').trim();
        if (owner && meName && owner !== meName) {
            // Non-owner had to invent a key because the owner's envelope was not
            // available/decryptable yet — incoming messages from the peer will stay
            // unreadable until the owner's key is adopted.
            this.addLogEntry({ type: 'WARN', msg: `Ключ диалога не получен от собеседника, сгенерирован временный (scope=${scope})`, ts: new Date().toLocaleTimeString() });
        } else {
            this.addLogEntry({ type: 'INFO', msg: `Сгенерирован новый ключ диалога (scope=${scope})`, ts: new Date().toLocaleTimeString() });
        }
        this.updateCryptoKeyDisplay({ key: localKey, peer, serverId, channelId });

        const requiresPeerEnvelope = !!(peer && !serverId && !channelId && String(peer).trim() !== this.myName());
        if (requiresPeerEnvelope) {
            void this.publishConversationKeyToPeer({ peer, scope, key: localKey, reason }).then((published) => {
                if (published === true) {
                    if (!this._publishedKeyScopes) this._publishedKeyScopes = new Set();
                    this._publishedKeyScopes.add(scope);
                } else {
                    // 'no_devices' included: the peer has no registered devices yet, so
                    // nothing was delivered — keep the scope unmarked so the next send
                    // retries once the peer's device appears.
                    this.trace(`resolveConversationCryptoKey reason=${reason} scope=${scope} publish_pending=true result=${published}`);
                }
            });
        }
        return localKey;
    }

    ensureConversationCryptoKey({ peer = null, serverId = null, channelId = null, reason = 'auto' } = {}) {
        const scope = this.conversationScopeKey(peer, serverId, channelId);
        if (!scope) return '';
        const stored = this.getStoredConversationKey(scope);
        if (stored) {
            this.activeConversationScope = scope;
            try {
                window.__ZALI_ACTIVE_CONVERSATION_SCOPE = scope;
            } catch (e) {}
            this.syncNativeConversationKeys();
            this.updateCryptoKeyDisplay({
                key: stored,
                peer,
                serverId,
                channelId,
            });
            return stored;
        }

        this.trace(`ensureConversationCryptoKey reason=${reason} scope=${scope} missing`);
        void this.resolveConversationCryptoKey({ peer, serverId, channelId, reason });
        this.updateCryptoKeyDisplay({
            key: '',
            peer,
            serverId,
            channelId,
        });
        return '';
    }

    updateCryptoKeyDisplay({ key = null, peer = null, serverId = null, channelId = null } = {}) {
        const valueEl = document.getElementById('currentCryptoKeyValue');
        const metaEl = document.getElementById('currentCryptoKeyMeta');
        const currentKey = String(key || this.loadStoredCryptoKey() || '').trim();
        if (valueEl) valueEl.textContent = currentKey ? `задан (${currentKey.length} символов)` : 'не задан';
        if (metaEl) {
            if (serverId && channelId) {
                metaEl.textContent = `Контекст: сервер ${serverId} / канал ${channelId}`;
            } else if (peer) {
                metaEl.textContent = `Контекст: диалог с ${peer}`;
            } else {
                metaEl.textContent = 'Контекст: общий ключ';
            }
        }
    }

    base64FromBytes(bytes) {
        const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        let binary = '';
        for (let i = 0; i < arr.length; i += 0x8000) {
            binary += String.fromCharCode(...arr.subarray(i, i + 0x8000));
        }
        return btoa(binary);
    }

    bytesFromBase64(value) {
        const binary = atob(String(value || ''));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    randomBase64(size = 32) {
        const bytes = new Uint8Array(size);
        if (window.crypto?.getRandomValues) {
            window.crypto.getRandomValues(bytes);
        } else {
            throw new Error('Secure random unavailable: window.crypto.getRandomValues is required');
        }
        return this.base64FromBytes(bytes);
    }

    defaultDeviceLabel() {
        const platform = navigator.userAgentData?.platform || navigator.platform || 'Web';
        const agent = /Windows/i.test(navigator.userAgent) ? 'Windows'
            : /Mac/i.test(navigator.userAgent) ? 'Mac'
                : /iPhone|iPad/i.test(navigator.userAgent) ? 'iOS'
                    : /Android/i.test(navigator.userAgent) ? 'Android'
                        : 'Browser';
        return `${agent} ${platform}`.trim();
    }

    loadDeviceIdentity() {
        try {
            const raw = localStorage.getItem(this.deviceIdentityStorageKey());
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed?.deviceId && parsed?.publicKey) return parsed;
            // Deliberately no fallback to the legacy unsuffixed 'zali_device_identity_v1'
            // key here — see the comment in loadStoredMessageCache() for why: it would
            // hand a brand-new account a previous, unrelated account's device identity
            // (and with it, that account's approved-device status on the server).
            // This WKWebView's own storage has no identity yet — before generating a
            // fresh one (which the server would treat as a brand-new, unapproved
            // device with no key envelopes), check for an identity exported by another
            // shell on the same machine (see native.rs's injected_device_identity).
            const injected = this.loadInjectedDeviceIdentity();
            if (injected?.deviceId && injected?.publicKey) {
                try { localStorage.setItem(this.deviceIdentityStorageKey(), JSON.stringify(injected)); } catch (e) {}
                this.trace(`loadDeviceIdentity adopted injected identity deviceId=${injected.deviceId}`);
                return injected;
            }
        } catch (e) {}
        const identity = {
            deviceId: `dev_${this.randomBase64(18).replace(/[+/=]/g, '').slice(0, 24)}`,
            label: this.defaultDeviceLabel(),
            publicKey: this.randomBase64(32),
            signingKey: this.randomBase64(32),
            keyPackage: {
                version: 1,
                kind: 'zali-device-key-package',
                createdAt: new Date().toISOString(),
            },
        };
        try {
            localStorage.setItem(this.deviceIdentityStorageKey(), JSON.stringify(identity));
        } catch (e) {}
        return identity;
    }

    saveDeviceIdentity(identity) {
        try {
            localStorage.setItem(this.deviceIdentityStorageKey(), JSON.stringify(identity || {}));
        } catch (e) {}
        // Mirror the identity to the native shell so it survives a WebView storage wipe
        // (rebuild / restart / cleared data dir). Without this the Rust/Windows shell had
        // no persistence beyond localStorage — every wipe minted a fresh device_id, which
        // orphaned all previously-published key envelopes (they are addressed to a specific
        // recipient_device_id) and broke key convergence. See persistDeviceIdentityToNative.
        this.persistDeviceIdentityToNative(identity);
    }

    // Push the full device identity (incl. privateKeyJwk + e2ee keyPackage) to the native
    // shell, which writes shared_device_identity_{username}.json and re-injects it on the
    // next launch via window.__ZALI_INJECTED_DEVICE_IDENTITY. Mirrors what the macOS Swift
    // client already does; makes the identity stable per (machine, account) on all shells.
    persistDeviceIdentityToNative(identity) {
        try {
            if (!this.hasNativeBridge()) return;
            const username = String(this.myName() || '').trim();
            const deviceId = String(identity?.deviceId || '').trim();
            // No username yet (pre-auth) → we cannot name the per-user file; a later
            // post-auth save (bootstrapDeviceTrust) will persist it once the user is known.
            if (!username || !deviceId) return;
            this.postNativeMessage({
                type: NativeMessageTypes.PERSIST_DEVICE_IDENTITY,
                username,
                identity: JSON.stringify(identity),
            });
        } catch (e) {}
    }

    loadInjectedDeviceIdentity() {
        try {
            const raw = window.__ZALI_INJECTED_DEVICE_IDENTITY;
            if (!raw) return null;
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return (parsed && typeof parsed === 'object') ? parsed : null;
        } catch (e) {
            return null;
        }
    }

    currentDeviceId() {
        return String(this.S.deviceTrust?.current?.deviceId || this.loadDeviceIdentity()?.deviceId || '').trim();
    }

    async ensureDeviceCryptoIdentity() {
        const identity = this.loadDeviceIdentity();
        const e2ee = identity?.keyPackage?.e2ee;
        if (e2ee?.publicJwk && identity?.privateKeyJwk && e2ee?.alg === 'ECDH-P-256+A256GCM') {
            return identity;
        }
        if (!window.crypto?.subtle) {
            throw new Error('WebCrypto недоступен для E2E ключей устройства');
        }
        const keyPair = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveKey']
        );
        const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
        const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
        const next = {
            ...identity,
            publicKey: JSON.stringify(publicJwk),
            privateKeyJwk: privateJwk,
            keyPackage: {
                ...(identity.keyPackage && typeof identity.keyPackage === 'object' ? identity.keyPackage : {}),
                version: 2,
                kind: 'zali-device-key-package',
                createdAt: identity.keyPackage?.createdAt || new Date().toISOString(),
                e2ee: {
                    alg: 'ECDH-P-256+A256GCM',
                    publicJwk,
                    createdAt: new Date().toISOString(),
                },
            },
        };
        this.saveDeviceIdentity(next);
        this.S.deviceTrust.current = next;
        return next;
    }

    devicePublicJwk(device) {
        const kp = device?.keyPackage && typeof device.keyPackage === 'object' ? device.keyPackage : {};
        if (kp?.e2ee?.alg === 'ECDH-P-256+A256GCM' && kp?.e2ee?.publicJwk) {
            return kp.e2ee.publicJwk;
        }
        try {
            const parsed = JSON.parse(String(device?.publicKey || ''));
            if (parsed?.kty === 'EC' && parsed?.crv === 'P-256') return parsed;
        } catch (e) {}
        return null;
    }

    async importEcdhPublicKey(jwk) {
        return await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            []
        );
    }

    async importEcdhPrivateKey(jwk) {
        return await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            ['deriveKey']
        );
    }

    async deriveEnvelopeAesKey(privateKey, publicKey, usages) {
        return await crypto.subtle.deriveKey(
            { name: 'ECDH', public: publicKey },
            privateKey,
            { name: 'AES-GCM', length: 256 },
            false,
            usages
        );
    }

    async encryptConversationKeyEnvelope({ scope, key, recipientDevice, peer }) {
        const identity = await this.ensureDeviceCryptoIdentity();
        const recipientJwk = this.devicePublicJwk(recipientDevice);
        if (!recipientJwk) throw new Error('Устройство получателя без E2E public key');
        const recipientPublicKey = await this.importEcdhPublicKey(recipientJwk);
        const ephemeral = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveKey']
        );
        const aesKey = await this.deriveEnvelopeAesKey(ephemeral.privateKey, recipientPublicKey, ['encrypt']);
        const iv = new Uint8Array(12);
        crypto.getRandomValues(iv);
        const plain = new TextEncoder().encode(JSON.stringify({
            scope,
            key,
            sender: this.myName(),
            peer,
            senderDeviceId: identity.deviceId,
            recipientDeviceId: recipientDevice.deviceId,
            createdAt: new Date().toISOString(),
        }));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plain);
        const ephemeralPublicJwk = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
        return JSON.stringify({
            version: 2,
            kind: 'zali-conversation-key-envelope',
            alg: 'ECDH-P-256+A256GCM',
            scope,
            sender: this.myName(),
            senderDeviceId: identity.deviceId,
            recipientDeviceId: recipientDevice.deviceId,
            ephemeralPublicJwk,
            iv: this.base64FromBytes(iv),
            ciphertext: this.base64FromBytes(ciphertext),
        });
    }

    async decryptConversationKeyEnvelope(encryptedKey) {
        const identity = await this.ensureDeviceCryptoIdentity();
        const envelope = JSON.parse(String(encryptedKey || ''));
        if (envelope?.version !== 2 || envelope?.kind !== 'zali-conversation-key-envelope') {
            throw new Error('Неподдерживаемый key envelope');
        }
        if (String(envelope.recipientDeviceId || '') !== String(identity.deviceId || '')) {
            throw new Error('Envelope предназначен другому устройству');
        }
        const privateKey = await this.importEcdhPrivateKey(identity.privateKeyJwk);
        const ephemeralPublicKey = await this.importEcdhPublicKey(envelope.ephemeralPublicJwk);
        const aesKey = await this.deriveEnvelopeAesKey(privateKey, ephemeralPublicKey, ['decrypt']);
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: this.bytesFromBase64(envelope.iv) },
            aesKey,
            this.bytesFromBase64(envelope.ciphertext)
        );
        const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(plain)));
        return {
            scope: String(payload.scope || envelope.scope || '').trim(),
            key: String(payload.key || '').trim(),
            sender: String(payload.sender || envelope.sender || '').trim(),
        };
    }


    async deriveVaultAesKey(code, saltBytes) {
        const passphrase = String(code || '').trim();
        if (!passphrase) throw new Error('Введите одноразовый код vault');
        if (!window.crypto?.subtle) throw new Error('WebCrypto недоступен');
        const material = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(passphrase),
            'PBKDF2',
            false,
            ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: saltBytes,
                iterations: 210000,
                hash: 'SHA-256',
            },
            material,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async encryptVaultPackage(payload, code) {
        const salt = new Uint8Array(16);
        const iv = new Uint8Array(12);
        crypto.getRandomValues(salt);
        crypto.getRandomValues(iv);
        const key = await this.deriveVaultAesKey(code, salt);
        const plain = new TextEncoder().encode(JSON.stringify(payload));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
        return `zali-vault:${this.base64FromBytes(new TextEncoder().encode(JSON.stringify({
            v: 1,
            kdf: 'PBKDF2-SHA256',
            iterations: 210000,
            aead: 'AES-256-GCM',
            salt: this.base64FromBytes(salt),
            iv: this.base64FromBytes(iv),
            ciphertext: this.base64FromBytes(ciphertext),
        })))}`;
    }

    async decryptVaultPackage(packageText, code) {
        const raw = String(packageText || '').trim();
        const encoded = raw.startsWith('zali-vault:') ? raw.slice('zali-vault:'.length) : raw;
        const envelope = JSON.parse(new TextDecoder().decode(this.bytesFromBase64(encoded)));
        const salt = this.bytesFromBase64(envelope.salt);
        const iv = this.bytesFromBase64(envelope.iv);
        const ciphertext = this.bytesFromBase64(envelope.ciphertext);
        const key = await this.deriveVaultAesKey(code, salt);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return JSON.parse(new TextDecoder().decode(new Uint8Array(plain)));
    }

    buildVaultPlainPayload(targetDeviceId = '') {
        const stored = this.loadStoredConversationKeys();
        const me = String(this.myName() || '').trim();
        const isCloudBroadcast = !String(targetDeviceId || '').trim();
        const scopedKeys = {};
        for (const [scope, value] of Object.entries(stored)) {
            const key = String(value || '').trim();
            if (!key) continue;
            if (isCloudBroadcast) {
                // В общий (неадресный) cloud-пакет не включаем DM-ключи, которыми
                // владеет собеседник: их канонично доставляют конверты владельца.
                // Иначе временный ключ, сгенерированный до прихода конверта, разошёлся
                // бы по устройствам и мог затереть настоящий (старые клиенты мержат
                // vault поверх локальных ключей без сохранения кандидатов).
                const owner = this.dmScopeOwner(scope);
                if (owner && me && owner !== me) continue;
            }
            scopedKeys[scope] = key;
        }
        return {
            version: 2,
            keyEpoch: 2,
            kind: 'zali-account-vault-bootstrap',
            accountId: this.myName(),
            issuedByDevice: this.currentDeviceId(),
            issuedToDevice: String(targetDeviceId || '').trim(),
            vaultEpoch: Date.now(),
            allowedHistoryPolicy: '30_days',
            createdAt: new Date().toISOString(),
            conversationKeys: scopedKeys,
        };
    }

    applyVaultPlainPayload(payload) {
        if (!payload || typeof payload !== 'object' || payload.kind !== 'zali-account-vault-bootstrap') {
            throw new Error('Это не Zali vault package');
        }
        if (Number(payload.version || 0) !== 2 || Number(payload.keyEpoch || 0) !== 2) {
            throw new Error('Vault package создан старой схемой ключей');
        }
        const accountId = String(payload.accountId || '').trim();
        if (accountId && accountId !== this.myName()) {
            throw new Error(`Vault предназначен для аккаунта ${accountId}`);
        }
        const nextKeys = this.loadStoredConversationKeys();
        const incomingKeys = payload.conversationKeys && typeof payload.conversationKeys === 'object'
            ? payload.conversationKeys
            : {};
        for (const [scope, value] of Object.entries(incomingKeys)) {
            const current = String(nextKeys[scope] || '').trim();
            const next = String(value || '').trim();
            if (!next) continue;
            if (current && current !== next) {
                // Облачный ключ замещает локальный, но локальный сохраняется как
                // кандидат расшифровки: если в облако попал не тот ключ (например,
                // временный с нового устройства), история, зашифрованная прежним,
                // не должна стать нечитаемой.
                this.addAltConversationKey(nextKeys, scope, current);
            }
            nextKeys[scope] = next;
        }
        this.saveStoredConversationKeys(nextKeys);
        const displayKey = String(Object.values(nextKeys)[0] || '').trim();
        this.updateCryptoKeyDisplay({ key: displayKey });
        this.refreshAfterKey();
        return Object.keys(nextKeys).length;
    }

    scheduleCloudVaultSync(delayMs = 300) {
        if (!this.S.session?.token || !this.S.auth?.vaultPassphrase || !this.isVaultCloudSyncEnabled()) return;
        if (this.cloudVaultSyncTimer) {
            clearTimeout(this.cloudVaultSyncTimer);
        }
        this.cloudVaultSyncTimer = window.setTimeout(() => {
            this.cloudVaultSyncTimer = 0;
            void this.syncCloudVaultPackage({ reason: 'scheduled' });
        }, Math.max(0, Number(delayMs) || 0));
    }

    async syncCloudVaultPackage({ passphrase = null, reason = 'auto' } = {}) {
        if (!this.S.session?.token) return false;
        if (!this.isVaultCloudSyncEnabled()) {
            this.trace(`syncCloudVaultPackage skipped reason=${reason} disabled=true`);
            return false;
        }
        const code = String(passphrase || this.S.auth?.vaultPassphrase || '').trim();
        if (!code) return false;
        if (this.cloudVaultSyncInFlight) return false;

        this.cloudVaultSyncInFlight = true;
        try {
            this.S.auth.vaultPassphrase = code;
            await this.ensureServerVaultReset({ reason: `syncCloudVaultPackage:${reason}` });

            let imported = false;
            let sawCompatibleServerEvents = false;
            let undecryptableServerEvents = false;
            try {
                const res = await this.apiFetch(this.apiRoutes.vault.events);
                if (res.ok) {
                    const events = await res.json();
                    if (Array.isArray(events) && events.length > 0) {
                        const latest = events[events.length - 1];
                        const encrypted = String(latest?.encryptedVaultEvent || '').trim();
                        if (encrypted) {
                            let payload = null;
                            try {
                                payload = await this.decryptVaultPackage(encrypted, code);
                            } catch (e) {
                                undecryptableServerEvents = true;
                                this.trace(`syncCloudVaultPackage decrypt failed reason=${reason} error=${e?.message || e}`);
                            }
                            if (payload) {
                                try {
                                    this.applyVaultPlainPayload(payload);
                                    await this.saveCloudVaultSnapshot(payload, this.S.session?.token);
                                    sawCompatibleServerEvents = true;
                                    imported = true;
                                    this.trace(`syncCloudVaultPackage imported reason=${reason} events=${events.length}`);
                                } catch (e) {
                                    // Расшифровалось, но пакет старой схемы — публикация ниже
                                    // выступает как upgrade до v2, это допустимо.
                                    this.trace(`syncCloudVaultPackage import failed reason=${reason} error=${e?.message || e}`);
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                this.trace(`syncCloudVaultPackage fetch failed reason=${reason} error=${e?.message || e}`);
            }

            if (!this.isVaultCloudSyncEnabled()) {
                this.trace(`syncCloudVaultPackage aborted reason=${reason} disabled_after_fetch=true`);
                return imported;
            }

            if (sawCompatibleServerEvents) {
                return imported;
            }

            if (undecryptableServerEvents) {
                // На сервере есть vault-события, которые не открылись этой passphrase.
                // Публиковать поверх них нельзя: локальные ключи здесь могут быть
                // свежесгенерированными временными, и новое «последнее» событие
                // затенило бы настоящие ключи для всех последующих устройств.
                this.trace(`syncCloudVaultPackage publish skipped reason=${reason} undecryptable_server_events=true`);
                this.addLogEntry({ type: 'WARN', msg: 'Cloud vault: события на сервере не расшифровались текущей passphrase, публикация ключей пропущена', ts: new Date().toLocaleTimeString() });
                return false;
            }

            const payload = this.buildVaultPlainPayload('');
            const hasKeys = Object.keys(payload.conversationKeys || {}).length > 0;
            if (!hasKeys) {
                return imported;
            }

            const encryptedVaultEvent = await this.encryptVaultPackage(payload, code);
            const vaultRes = await this.apiFetch(this.apiRoutes.vault.events, {
                method: 'POST',
                body: JSON.stringify({
                    issuedToDeviceId: null,
                    vaultEpoch: payload.vaultEpoch,
                    encryptedVaultEvent,
                }),
            });
            if (!vaultRes.ok) {
                throw new Error(await vaultRes.text().catch(() => 'Не удалось сохранить cloud vault event'));
            }
            await this.saveCloudVaultSnapshot(payload, this.S.session?.token);
            this.trace(`syncCloudVaultPackage published reason=${reason} imported=${imported}`);
            return true;
        } catch (e) {
            this.trace(`syncCloudVaultPackage error reason=${reason} error=${e?.message || e}`);
            return false;
        } finally {
            this.cloudVaultSyncInFlight = false;
        }
    }

    async publishConversationKeyToPeer({ peer, scope, key, reason = 'auto' } = {}) {
        const recipient = String(peer || '').trim();
        const scoped = String(scope || '').trim();
        const secret = String(key || '').trim();
        if (!this.S.session?.token || !recipient || !scoped || !secret || recipient === this.myName()) return false;
        try {
            await this.ensureDeviceCryptoIdentity();
            const res = await this.apiFetch(this.apiRoutes.devices.publicByUser(recipient));
            if (!res.ok) throw new Error(await res.text().catch(() => 'Не удалось получить устройства контакта'));
            const devices = await res.json();
            const usable = Array.isArray(devices)
                ? devices.filter(device => !device?.revoked && this.devicePublicJwk(device))
                : [];
            if (!usable.length) {
                this.trace(`publishConversationKeyToPeer skipped reason=${reason} peer=${recipient} devices=0`);
                return 'no_devices';
            }
            const results = await Promise.allSettled(usable.map(async device => {
                const encryptedKey = await this.encryptConversationKeyEnvelope({
                    scope: scoped,
                    key: secret,
                    recipientDevice: device,
                    peer: recipient,
                });
                const post = await this.apiFetch(this.apiRoutes.keyEnvelopes.base, {
                    method: 'POST',
                    includeDeviceId: true,
                    body: JSON.stringify({
                        recipient,
                        scope: scoped,
                        recipientDeviceId: device.deviceId,
                        senderDeviceId: this.currentDeviceId(),
                        encryptedKey,
                    }),
                });
                if (!post.ok) throw new Error(await post.text().catch(() => 'Не удалось сохранить key envelope'));
            }));
            const succeeded = results.filter(r => r.status === 'fulfilled').length;
            if (!succeeded) {
                const firstErr = results.find(r => r.status === 'rejected')?.reason;
                throw new Error(firstErr?.message || 'Не удалось опубликовать ни один key envelope');
            }
            this.trace(`publishConversationKeyToPeer reason=${reason} peer=${recipient} devices=${usable.length}`);
            return true;
        } catch (e) {
            this.trace(`publishConversationKeyToPeer failed reason=${reason} peer=${recipient} error=${e?.message || e}`);
            return false;
        }
    }

    peerFromConversationScope(scope) {
        const parts = String(scope || '').trim().split(':');
        if (parts.length !== 3 || parts[0] !== 'dm') return '';
        const me = String(this.myName() || '').trim();
        if (!me) return '';
        if (parts[1] === me) return parts[2] || '';
        if (parts[2] === me) return parts[1] || '';
        return '';
    }

    async retryPublishConversationKeys({ reason = 'auto', limit = 20 } = {}) {
        if (!this.S.session?.token) return 0;
        const stored = this.loadStoredConversationKeys();
        const entries = Object.entries(stored)
            .filter(([scope, key]) => String(scope || '').startsWith('dm:') && String(key || '').trim())
            .slice(0, Math.max(1, Number(limit) || 20));
        let published = 0;
        for (const [scope, key] of entries) {
            const peer = this.peerFromConversationScope(scope);
            if (!peer) continue;
            const result = await this.publishConversationKeyToPeer({ peer, scope, key, reason: `retry:${reason}` });
            // 'no_devices' is truthy but means nothing was delivered — the peer has
            // no registered devices yet, so the envelope must be retried later.
            if (result === true) {
                published += 1;
            }
        }
        if (published) {
            this.trace(`retryPublishConversationKeys reason=${reason} published=${published}`);
        }
        return published;
    }

    async syncIncomingKeyEnvelopes({ reason = 'auto', triggerRefresh = true } = {}) {
        if (!this.S.session?.token) return 0;
        try {
            const identity = await this.ensureDeviceCryptoIdentity();
            const res = await this.apiFetch(this.apiRoutes.keyEnvelopes.list(identity.deviceId), { includeDeviceId: true });
            if (!res.ok) throw new Error(await res.text().catch(() => 'Не удалось получить key envelopes'));
            const envelopes = await res.json();
            if (!Array.isArray(envelopes) || !envelopes.length) {
                this.addLogEntry({ type: 'INFO', msg: `Ключи: на сервере нет конвертов для этого устройства (${String(identity.deviceId || '').slice(0, 12)})`, ts: new Date().toLocaleTimeString() });
                return 0;
            }
            const stored = this.loadStoredConversationKeys();
            let imported = 0;
            let decryptFailed = 0;
            let skippedSame = 0;
            for (const record of envelopes) {
                try {
                    const payload = await this.decryptConversationKeyEnvelope(record?.encryptedKey);
                    if (!payload.scope || !payload.key) continue;
                    const scope = String(payload.scope);
                    const current = String(stored[scope] || '').trim();
                    if (!current) {
                        stored[scope] = payload.key;
                        imported += 1;
                    } else if (current !== payload.key && this.keyEnvelopeOverridesLocal(scope, payload)) {
                        // The canonical owner's key becomes the active (sending) key so
                        // both peers converge. Preserve the previous key as a decryption
                        // candidate so messages already encrypted with it stay readable.
                        this.trace(`syncIncomingKeyEnvelopes adopt owner key scope=${scope} sender=${payload.sender}`);
                        this.addAltConversationKey(stored, scope, current);
                        stored[scope] = payload.key;
                        imported += 1;
                    } else if (current !== payload.key) {
                        // Not the canonical key, but keep it as a decryption candidate:
                        // the peer may have encrypted messages with it before convergence.
                        if (this.addAltConversationKey(stored, scope, payload.key)) imported += 1;
                        else skippedSame += 1;
                    } else {
                        skippedSame += 1;
                    }
                } catch (e) {
                    decryptFailed += 1;
                    this.trace(`syncIncomingKeyEnvelopes decrypt failed reason=${reason} error=${e?.message || e}`);
                }
            }
            // Surface the outcome in the in-app log panel. decryptFailed>0 means the
            // envelope was encrypted to a device key this client cannot open (device
            // identity mismatch) — that is why a delivered message stays unreadable.
            this.addLogEntry({
                type: decryptFailed > 0 ? 'WARN' : 'INFO',
                msg: `Ключи: получено ${envelopes.length}, принято ${imported}, совпало ${skippedSame}, не расшифровано ${decryptFailed} (reason=${reason})`,
                ts: new Date().toLocaleTimeString()
            });
            if (imported > 0) {
                this.saveStoredConversationKeys(stored);
                this.trace(`syncIncomingKeyEnvelopes reason=${reason} imported=${imported}`);
                if (triggerRefresh) this.refreshAfterKey();
            }
            return imported;
        } catch (e) {
            this.trace(`syncIncomingKeyEnvelopes failed reason=${reason} error=${e?.message || e}`);
            return 0;
        }
    }

    async bootstrapDeviceTrust() {
        if (!this.S.session?.token) return;
        const identity = await this.timeStage('  ├ ensureDeviceCryptoIdentity', () => this.ensureDeviceCryptoIdentity());
        this.S.deviceTrust.current = identity;
        // Persist to the native shell now that the user is authenticated: ensureDeviceCryptoIdentity
        // returns early (no saveDeviceIdentity) when the identity is already complete, so the
        // in-memory identity might never have been mirrored to the native per-user file yet.
        this.persistDeviceIdentityToNative(identity);
        try {
            const res = await this.timeStage('  ├ devices.register(POST)', () => this.apiFetch(this.apiRoutes.devices.list, {
                method: 'POST',
                includeDeviceId: true,
                body: JSON.stringify({
                    deviceId: identity.deviceId,
                    label: identity.label,
                    publicKey: identity.publicKey,
                    signingKey: identity.signingKey,
                    keyPackage: identity.keyPackage,
                }),
            }));
            if (res.ok) {
                this.S.deviceTrust.current = await res.json();
            }
            // Neither the device-trust panel refresh nor a key-envelope sync is needed
            // before the chat can render, and postAuthSetup already syncs envelopes on
            // its critical path. Run these in the background so device registration does
            // not block startup (the sync could stall for the full request timeout).
            void this.timeStage('  ├ refreshDeviceTrust(bg)', () => this.refreshDeviceTrust());
            void this.timeStage('  └ syncIncomingKeyEnvelopes(bootstrap,bg)', () => this.syncIncomingKeyEnvelopes({ reason: 'bootstrapDeviceTrust' }));
        } catch (e) {
            this.S.deviceTrust.status = `Устройство не зарегистрировано: ${e?.message || e}`;
            this.renderDeviceTrustPanel();
        }
    }

    async resetEncryptionKeys() {
        this.trace('resetEncryptionKeys start');
        // 1. Clear local AES conversation keys
        this._publishedKeyScopes = new Set();
        this._vaultSnapshotApplied = false;
        this.saveStoredConversationKeys({});
        try { sessionStorage.removeItem(this.cryptoKeyStorageKey()); } catch (e) {}
        try { localStorage.removeItem(this.cryptoKeyStorageKey()); } catch (e) {}

        // 2. Delete all server-side key envelopes (sent and received)
        try {
            await this.apiFetch(this.apiRoutes.keyEnvelopes.base, {
                method: 'DELETE',
                includeDeviceId: true,
            });
        } catch (e) {
            this.trace(`resetEncryptionKeys server delete failed: ${e?.message || e}`);
        }

        // 3. Regenerate ECDH keypair — strip e2ee from identity, let ensureDeviceCryptoIdentity rebuild it
        const identity = this.loadDeviceIdentity();
        const stripped = { ...identity, privateKeyJwk: undefined };
        if (stripped.keyPackage && typeof stripped.keyPackage === 'object') {
            stripped.keyPackage = { ...stripped.keyPackage };
            delete stripped.keyPackage.e2ee;
        }
        delete stripped.privateKeyJwk;
        this.saveDeviceIdentity(stripped);

        // 4. Generate new ECDH keypair and push new public key to server
        await this.bootstrapDeviceTrust();
        this.trace('resetEncryptionKeys done');
    }

    async refreshDeviceTrust() {
        if (!this.S.session?.token) return;
        try {
            const res = await this.apiFetch(this.apiRoutes.devices.list, { includeDeviceId: true });
            if (!res.ok) throw new Error(await res.text().catch(() => 'Не удалось загрузить устройства'));
            this.S.deviceTrust.devices = await res.json();
            this.renderDeviceTrustPanel();
        } catch (e) {
            this.S.deviceTrust.status = `Список устройств недоступен: ${e?.message || e}`;
            this.renderDeviceTrustPanel();
        }
    }

    async approveDeviceAndExport(deviceId) {
        const targetId = String(deviceId || '').trim();
        if (!targetId) return;
        if (!this.loadStoredCryptoKey() && !Object.keys(this.loadStoredConversationKeys()).length) {
            this.S.deviceTrust.status = 'Сначала задайте ключ шифрования или откройте чат с уже заданным ключом.';
            this.renderDeviceTrustPanel();
            return;
        }
        const code = this.randomBase64(12).replace(/[+/=]/g, '').slice(0, 16);
        try {
            const res = await this.apiFetch(this.apiRoutes.devices.approve, {
                method: 'POST',
                includeDeviceId: true,
                body: JSON.stringify({
                    deviceId: targetId,
                    approvedByDeviceId: this.currentDeviceId(),
                    historyDays: 30,
                }),
            });
            if (!res.ok) throw new Error(await res.text().catch(() => 'Не удалось подтвердить устройство'));

            const payload = this.buildVaultPlainPayload(targetId);
            const encryptedVaultEvent = await this.encryptVaultPackage(payload, code);
            const vaultRes = await this.apiFetch(this.apiRoutes.vault.events, {
                method: 'POST',
                body: JSON.stringify({
                    vaultEpoch: payload.vaultEpoch,
                    encryptedVaultEvent,
                }),
            });
            if (!vaultRes.ok) {
                throw new Error(await vaultRes.text().catch(() => 'Не удалось сохранить vault event'));
            }

            const now = new Date();
            const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            const expires = new Date(now.getTime() + 60 * 60 * 1000);
            const scopes = Object.keys(payload.conversationKeys || {})
                .filter(scope => !String(scope).startsWith('alt:'));
            await Promise.all(scopes.slice(0, 50).map(async scope => {
                const res = await this.apiFetch(this.apiRoutes.historyTickets, {
                    method: 'POST',
                    includeDeviceId: true,
                    body: JSON.stringify({
                        issuedByDeviceId: this.currentDeviceId(),
                        issuedToDeviceId: targetId,
                        conversationId: scope,
                        fromTime: from.toISOString(),
                        toTime: now.toISOString(),
                        expiresAt: expires.toISOString(),
                        encryptedExportSecrets: encryptedVaultEvent,
                    }),
                });
                if (!res.ok) {
                    throw new Error(await res.text().catch(() => 'Не удалось сохранить history ticket'));
                }
                return res;
            }));

            this.S.deviceTrust.exportPackage = encryptedVaultEvent;
            this.S.deviceTrust.exportCode = code;
            this.S.deviceTrust.status = `Устройство подтверждено. Передайте bootstrap package и код ${code} на новое устройство.`;
            await this.refreshDeviceTrust();
        } catch (e) {
            this.S.deviceTrust.status = `Не удалось подтвердить устройство: ${e?.message || e}`;
            this.renderDeviceTrustPanel();
        }
    }

    async importVaultPackageFromInputs() {
        const packageText = String(document.getElementById('deviceVaultPackageInput')?.value || this.S.deviceTrust.importPackage || '').trim();
        const code = String(document.getElementById('deviceVaultCodeInput')?.value || this.S.deviceTrust.importCode || '').trim();
        if (!packageText || !code) {
            this.S.deviceTrust.status = 'Вставьте vault package и одноразовый код.';
            this.renderDeviceTrustPanel();
            return;
        }
        try {
            const payload = await this.decryptVaultPackage(packageText, code);
            const count = this.applyVaultPlainPayload(payload);
            this.S.deviceTrust.status = `Vault импортирован: ключей чатов ${count}. История перечитывается с учетом разрешенного окна.`;
            await this.refreshAfterKey();
            this.renderDeviceTrustPanel();
        } catch (e) {
            this.S.deviceTrust.status = `Vault не расшифрован: ${e?.message || e}`;
            this.renderDeviceTrustPanel();
        }
    }

    async exportCurrentVaultPackage() {
        const code = String(document.getElementById('deviceVaultManualCodeInput')?.value || '').trim() || this.randomBase64(12).replace(/[+/=]/g, '').slice(0, 16);
        try {
            const payload = this.buildVaultPlainPayload('');
            const encrypted = await this.encryptVaultPackage(payload, code);
            this.S.deviceTrust.exportPackage = encrypted;
            this.S.deviceTrust.exportCode = code;
            this.S.deviceTrust.status = `Vault package создан. Код: ${code}`;
            if (this.S.session?.token) {
                const vaultRes = await this.apiFetch(this.apiRoutes.vault.events, {
                    method: 'POST',
                    body: JSON.stringify({
                        vaultEpoch: payload.vaultEpoch,
                        encryptedVaultEvent: encrypted,
                    }),
                });
                if (!vaultRes.ok) {
                    throw new Error(await vaultRes.text().catch(() => 'Не удалось сохранить vault event'));
                }
            }
            this.renderDeviceTrustPanel();
        } catch (e) {
            this.S.deviceTrust.status = `Не удалось создать vault package: ${e?.message || e}`;
            this.renderDeviceTrustPanel();
        }
    }

    async revokeTrustedDevice(deviceId) {
        const id = String(deviceId || '').trim();
        if (!id || id === this.currentDeviceId()) {
            this.S.deviceTrust.status = 'Текущее устройство нельзя отозвать из этого блока.';
            this.renderDeviceTrustPanel();
            return;
        }
        try {
            const res = await this.apiFetch(this.apiRoutes.devices.byId(id), { method: 'DELETE', includeDeviceId: true });
            if (!res.ok) throw new Error(await res.text().catch(() => 'Не удалось отозвать устройство'));
            this.S.deviceTrust.status = 'Устройство отозвано, сервер создал новую эпоху device group.';
            await this.refreshDeviceTrust();
        } catch (e) {
            this.S.deviceTrust.status = `Отзыв не выполнен: ${e?.message || e}`;
            this.renderDeviceTrustPanel();
        }
    }

    renderDeviceTrustPanel() {
        const currentEl = document.getElementById('deviceTrustCurrent');
        const listEl = document.getElementById('deviceTrustList');
        const statusEl = document.getElementById('deviceTrustStatus');
        const packageEl = document.getElementById('deviceVaultExportPackage');
        const codeEl = document.getElementById('deviceVaultExportCode');
        if (currentEl) {
            const current = this.S.deviceTrust.current || this.loadDeviceIdentity();
            currentEl.textContent = current?.deviceId ? `${current.label || 'Устройство'} · ${current.deviceId}` : 'не зарегистрировано';
        }
        if (statusEl) statusEl.textContent = this.S.deviceTrust.status || '';
        if (packageEl && packageEl.value !== this.S.deviceTrust.exportPackage) packageEl.value = this.S.deviceTrust.exportPackage || '';
        if (codeEl) codeEl.textContent = this.S.deviceTrust.exportCode ? `Код: ${this.S.deviceTrust.exportCode}` : 'Код появится после экспорта';
        if (!listEl) return;
        const devices = Array.isArray(this.S.deviceTrust.devices) ? this.S.deviceTrust.devices : [];
        if (!devices.length) {
            listEl.innerHTML = '<p class="settings-help">После входа устройство зарегистрируется автоматически.</p>';
            return;
        }
        listEl.innerHTML = devices.map(device => {
            const id = String(device.deviceId || '').trim();
            const isCurrent = id === this.currentDeviceId();
            const state = device.revoked ? 'отозвано' : device.approved ? 'доверенное' : 'ожидает';
            const actions = device.revoked ? ''
                : !device.approved
                    ? `<button class="btn-flat" type="button" data-device-approve="${this.esc(id)}">Подтвердить</button>`
                    : (!isCurrent ? `<button class="btn-flat" type="button" data-device-revoke="${this.esc(id)}">Отозвать</button>` : '');
            return `
                <div class="device-row">
                    <div>
                        <strong>${this.esc(device.label || 'Устройство')}</strong>
                        <small>${this.esc(id)} · эпоха ${this.esc(device.groupEpoch || 1)} · ${this.esc(state)}</small>
                    </div>
                    <div class="settings-inline-actions">${actions}</div>
                </div>
            `;
        }).join('');
    }

    updateChatHeaderCryptoKey({ peer = null, serverId = null, channelId = null } = {}) {
        const chatHdrSub = document.getElementById('chatHdrSub');
        if (!chatHdrSub) return;
        const key = this.ensureConversationCryptoKey({ peer, serverId, channelId, reason: 'updateChatHeaderCryptoKey' });
        const desc = serverId && channelId
            ? `${String(serverId).trim()} / ${String(channelId).trim()}`
            : peer
                ? `Диалог с ${String(peer).trim()}`
                : 'Личное сообщение';
        chatHdrSub.innerHTML = `
            <span class="chat-hdr-desc">${this.esc(desc)}</span>
            <span class="chat-hdr-key">${this.esc(key ? 'Ключ: задан' : 'Ключ: не задан')}</span>
        `;
    }

    saveStoredCryptoKey(key) {
        try {
            const value = (key || '').trim();
            this.trace(`saveStoredCryptoKey keySet=${!!value} length=${value.length}`);
            if (value) {
                sessionStorage.setItem(this.cryptoKeyStorageKey(), value);
                localStorage.removeItem(this.cryptoKeyStorageKey());
            } else {
                sessionStorage.removeItem(this.cryptoKeyStorageKey());
                localStorage.removeItem(this.cryptoKeyStorageKey());
            }
            try {
                window.__ZALI_SAVED_KEY = value;
            } catch (e) {}
            try {
                const scope = String(window.__ZALI_ACTIVE_CONVERSATION_SCOPE || this.activeConversationScope || '').trim();
                if (scope) {
                    const stored = this.loadStoredConversationKeys();
                    if (value) {
                        stored[scope] = value;
                    } else {
                        delete stored[scope];
                    }
                    this.saveStoredConversationKeys(stored);
                }
            } catch (e) {}
            if (this.nativeSupports('setKey')) {
                this.trace(`saveStoredCryptoKey native setKey keySet=${!!value}`);
                this.syncNativeConversationKeys();
            }
            if (this.S.session?.token && this.S.auth?.vaultPassphrase && !this.cloudVaultSyncInFlight) {
                this.scheduleCloudVaultSync(300);
            }
        } catch (e) {}
    }

    loadStoredSession(key = null) {
        try {
            const raw = localStorage.getItem(key || this.authStorageKey());
            if (!raw) {
                const injected = key ? null : this.loadInjectedSession();
                this.trace(`loadStoredSession key=${key || 'auth'} local=no injected=${!!injected}`);
                return this.normalizeSession(injected);
            }
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            const normalized = this.normalizeSession(parsed);
            const token = String(normalized?.token || '').trim();
            if (!token) {
                const injected = key ? null : this.loadInjectedSession();
                this.trace(`loadStoredSession key=${key || 'auth'} local=tokenless injected=${!!injected}`);
                return this.normalizeSession(injected) || null;
            }
            this.trace(`loadStoredSession key=${key || 'auth'} local=yes`);
            return normalized;
        } catch (e) {
            this.trace(`loadStoredSession key=${key || 'auth'} error`);
            if (!key) {
                return this.normalizeSession(this.loadInjectedSession());
            }
            return null;
        }
    }

    normalizeSession(session) {
        if (!session || typeof session !== 'object') return null;
        const username = String(session.username || session.user || '').trim();
        const token = String(
            session.token
            || session.authToken
            || session.accessToken
            || session.sessionToken
            || session.jwt
            || ''
        ).trim();
        if (!token) return null;
        return {
            username,
            token,
            guest: !!session.guest || false,
            tokenExpiresAt: Number(session.tokenExpiresAt || this.tokenExpiresAt(token) || 0),
        };
    }

    decodeJwtPayload(token) {
        try {
            const parts = String(token || '').split('.');
            if (parts.length < 2) return null;
            const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
            return JSON.parse(atob(padded));
        } catch (e) {
            return null;
        }
    }

    tokenExpiresAt(token) {
        const payload = this.decodeJwtPayload(token);
        const exp = Number(payload?.exp || 0);
        return exp > 0 ? exp * 1000 : 0;
    }

    isTokenExpired(token, skewMs = 30000) {
        const expiresAt = this.tokenExpiresAt(token);
        return expiresAt > 0 && expiresAt <= Date.now() + skewMs;
    }

    loadInjectedSession() {
        try {
            const raw = window.__ZALI_SAVED_SESSION;
            if (!raw || typeof raw !== 'object') return null;
            if (raw.token && this.isTokenExpired(raw.token)) return null;
            return this.normalizeSession(raw);
        } catch (e) {
            return null;
        }
    }

    formatDuration(ms) {
        const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        const pad = (v) => String(v).padStart(2, '0');
        return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
    }

    formatBytes(bytes) {
        const value = Math.max(0, Number(bytes || 0));
        if (!value) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let idx = 0;
        let current = value;
        while (current >= 1024 && idx < units.length - 1) {
            current /= 1024;
            idx += 1;
        }
        const digits = current >= 100 || idx === 0 ? 0 : current >= 10 ? 1 : 2;
        return `${current.toFixed(digits)} ${units[idx]}`;
    }

    describeIceCandidate(candidateLine) {
        const parts = String(candidateLine || '').trim().split(/\s+/);
        const typIndex = parts.indexOf('typ');
        return {
            protocol: String(parts[2] || '').toLowerCase(),
            address: parts[4] && parts[5] ? `${parts[4]}:${parts[5]}` : '',
            type: typIndex >= 0 ? String(parts[typIndex + 1] || '') : '',
        };
    }

    getVoicePrimaryPeerName() {
        const peers = Array.from(this.voice.peerConnections.keys()).map(name => String(name || '').trim()).filter(Boolean);
        const me = String(this.myName() || '').trim();
        const preferred = String(this.voice.targetUser || this.voice.inviter || '').trim();
        if (preferred && peers.includes(preferred)) return preferred;
        if (this.voice.roomType === 'dm') {
            const nonMe = peers.find(name => name !== me);
            if (nonMe) return nonMe;
        }
        return peers[0] || preferred || '';
    }

    getVoiceHealthSnapshot() {
        const peer = this.getVoicePrimaryPeerName();
        const entry = peer ? this.voice.peerConnections.get(peer) : null;
        const stats = entry?.lastStats || {};
        const audio = peer ? this.voice.remoteAudios.get(peer) : null;
        const playbackNode = peer ? this.voice.remotePlaybackNodes?.get(peer) : null;
        const remoteStream = audio?.srcObject instanceof MediaStream ? audio.srcObject : null;
        const localStream = this.voice.localStream;
        const connectionState = String(entry?.pc?.connectionState || 'idle').trim() || 'idle';
        const iceState = String(entry?.pc?.iceConnectionState || 'idle').trim() || 'idle';
        const signalingState = String(entry?.pc?.signalingState || 'idle').trim() || 'idle';
        const hasOut = Number(stats.outBytes || 0) > 0 || Number(stats.outPackets || 0) > 0;
        const hasIn = Number(stats.inBytes || 0) > 0 || Number(stats.inPackets || 0) > 0;
        const candidatePair = stats.candidatePair || null;
        const localCandidates = Number(stats.localCandidateCount || entry?.generatedIceCandidates || 0);
        const remoteCandidates = Number(stats.remoteCandidateCount || entry?.receivedIceCandidates || 0);
        const remoteTrackCount = remoteStream ? remoteStream.getAudioTracks().length : 0;
        const routeValue = playbackNode
            ? 'WebAudio'
            : audio
                ? (audio.paused ? 'audio paused' : 'audio ready')
                : remoteTrackCount
                    ? 'stream only'
                    : 'нет трека';
        const playbackValue = audio
            ? (audio.paused ? 'paused' : audio.readyState >= 2 ? 'playing' : 'waiting')
            : 'none';
        const micValue = localStream
            ? `${localStream.getAudioTracks().length} track${localStream.getAudioTracks().length === 1 ? '' : 's'}`
            : 'нет микрофона';

        const toneByState = (state, activeTone = 'good') => {
            const s = String(state || '').toLowerCase();
            if (['connected', 'completed', 'playing', 'ready', 'live'].includes(s)) return 'good';
            if (['connecting', 'checking', 'new', 'waiting', 'idle'].includes(s)) return 'warn';
            if (['disconnected', 'failed', 'closed', 'paused'].includes(s)) return 'bad';
            return activeTone;
        };

        return [
            {
                label: 'ICE',
                value: iceState,
                sub: connectionState === 'connected' ? 'канал поднят' : 'ожидаем согласование',
                tone: toneByState(iceState),
            },
            {
                label: 'RTP out',
                value: hasOut ? `${this.formatBytes(stats.outBytes || 0)} · ${stats.outPackets || 0} pkts` : '0 B',
                sub: hasOut ? 'уходит в сеть' : 'пока тишина',
                tone: hasOut ? 'good' : toneByState(connectionState, 'warn'),
            },
            {
                label: 'RTP in',
                value: hasIn ? `${this.formatBytes(stats.inBytes || 0)} · ${stats.inPackets || 0} pkts` : '0 B',
                sub: hasIn ? 'приходит с удалённой стороны' : 'не получаем RTP',
                tone: hasIn ? 'good' : 'bad',
            },
            {
                label: 'Candidate pair',
                value: candidatePair ? `${candidatePair.localLabel || candidatePair.local || 'local'} → ${candidatePair.remoteLabel || candidatePair.remote || 'remote'}` : 'не выбран',
                sub: candidatePair ? `rtt ${candidatePair.currentRoundTripTime ?? 'n/a'} · ${this.formatBytes(candidatePair.bytesSent || 0)} / ${this.formatBytes(candidatePair.bytesReceived || 0)}` : `local ${localCandidates} / remote ${remoteCandidates}`,
                tone: candidatePair ? 'good' : 'warn',
            },
            {
                label: 'Audio route',
                value: routeValue,
                sub: remoteTrackCount ? `tracks: ${remoteTrackCount}` : 'ждём remote-track',
                tone: remoteTrackCount ? 'good' : 'warn',
            },
            {
                label: 'Playback',
                value: playbackValue,
                sub: micValue,
                tone: audio ? (audio.paused ? 'warn' : 'good') : 'idle',
            },
        ];
    }

    saveStoredSession(session) {
        try {
            localStorage.setItem(this.authStorageKey(), JSON.stringify(session));
            localStorage.setItem(this.lastAuthStorageKey(), JSON.stringify(session));
            this.rememberRecentAccount(session);
            this.saveInjectedSession(session);
        } catch (e) {
            // ignore storage failures
        }
    }

    loadRecentAccounts() {
        try {
            const raw = localStorage.getItem(this.recentAccountsStorageKey());
            const parsed = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(parsed)) return [];
            const seenUsers = new Set();
            const seenTokens = new Set();
            return parsed
                .map(item => ({
                    ...this.normalizeSession(item),
                    lastUsedAt: Number(item?.lastUsedAt || 0),
                }))
                .filter(item => item?.token && !item.guest && !this.isTokenExpired(item.token))
                .sort((a, b) => Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0))
                .filter(item => {
                    const userKey = String(item.username || '').trim().toLowerCase();
                    const tokenKey = String(item.token || '').trim();
                    if (!userKey || !tokenKey || seenUsers.has(userKey) || seenTokens.has(tokenKey)) return false;
                    seenUsers.add(userKey);
                    seenTokens.add(tokenKey);
                    return true;
                })
                .slice(0, 6);
        } catch (e) {
            return [];
        }
    }

    saveRecentAccounts(accounts) {
        try {
            const seenUsers = new Set();
            const seenTokens = new Set();
            const normalized = [];
            for (const account of Array.isArray(accounts) ? accounts : []) {
                const session = this.normalizeSession(account);
                if (!session?.token || session.guest) continue;
                if (this.isTokenExpired(session.token)) continue;
                const key = String(session.username || '').trim().toLowerCase();
                const tokenKey = String(session.token || '').trim();
                if (!key || !tokenKey || seenUsers.has(key) || seenTokens.has(tokenKey)) continue;
                seenUsers.add(key);
                seenTokens.add(tokenKey);
                normalized.push({
                    username: session.username,
                    token: session.token,
                    guest: false,
                    lastUsedAt: Number(account?.lastUsedAt || Date.now()),
                    tokenExpiresAt: Number(session.tokenExpiresAt || this.tokenExpiresAt(session.token) || 0),
                });
                if (normalized.length >= 6) break;
            }
            localStorage.setItem(this.recentAccountsStorageKey(), JSON.stringify(normalized));
        } catch (e) {
            // ignore storage failures
        }
    }

    rememberRecentAccount(session) {
        const normalized = this.normalizeSession(session);
        if (!normalized?.token || normalized.guest) return;
        const key = String(normalized.username || '').trim().toLowerCase();
        if (!key) return;
        const rest = this.loadRecentAccounts()
            .filter(item => String(item.username || '').trim().toLowerCase() !== key);
        this.saveRecentAccounts([
            {
                username: normalized.username,
                token: normalized.token,
                guest: false,
                lastUsedAt: Date.now(),
                tokenExpiresAt: Number(normalized.tokenExpiresAt || this.tokenExpiresAt(normalized.token) || 0),
            },
            ...rest,
        ]);
        this.renderRecentAccounts();
    }

    forgetRecentAccount(username) {
        const key = String(username || '').trim().toLowerCase();
        if (!key) return;
        const next = this.loadRecentAccounts()
            .filter(item => String(item.username || '').trim().toLowerCase() !== key);
        this.saveRecentAccounts(next);
        this.renderRecentAccounts();
    }

    forgetRecentAccountEntry(username, token = '') {
        const userKey = String(username || '').trim().toLowerCase();
        const tokenKey = String(token || '').trim();
        if (!userKey && !tokenKey) return;
        const next = this.loadRecentAccounts()
            .filter(item => {
                const itemUser = String(item.username || '').trim().toLowerCase();
                const itemToken = String(item.token || '').trim();
                return (!userKey || itemUser !== userKey) && (!tokenKey || itemToken !== tokenKey);
            });
        this.saveRecentAccounts(next);
        this.renderRecentAccounts();
    }

    async verifyRecentAccountSession(session) {
        try {
            const token = String(session?.token || '').trim();
            if (!token) return { ok: false, invalidate: true };
            const res = await this.apiFetch(this.apiRoutes.auth.me, {
                timeoutMs: SESSION_RESTORE_TIMEOUT_MS,
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });
            if (!res.ok) {
                const status = Number(res.status || 0);
                return {
                    ok: false,
                    invalidate: status === 401 || status === 403,
                };
            }
            const data = await res.json();
            return {
                ok: true,
                invalidate: false,
                username: String(data?.username || session?.username || '').trim(),
                token,
                cloudVaultSyncEnabled: data?.cloudVaultSyncEnabled,
            };
        } catch (e) {
            return { ok: false, invalidate: false };
        }
    }

    formatRecentAccountTime(ts) {
        const value = Number(ts || 0);
        if (!value) return 'недавний вход';
        try {
            return `вход ${new Date(value).toLocaleDateString('ru-RU', {
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
            })}`;
        } catch (e) {
            return 'недавний вход';
        }
    }

    renderRecentAccounts() {
        const box = document.getElementById('recentAccounts');
        if (!box) return;
        const accounts = this.loadRecentAccounts();
        if (!accounts.length) {
            box.innerHTML = '<div class="recent-accounts-empty">После входа аккаунты появятся здесь для быстрого переключения на этом Mac.</div>';
            return;
        }
        const current = String(this.S.session?.username || '').trim().toLowerCase();
        const rows = accounts.map(account => {
            const username = String(account.username || '').trim();
            const active = username.toLowerCase() === current && !!this.S.session?.token;
            return `
                <div class="recent-account-row ${active ? 'is-active' : ''}">
                    <div class="recent-account-main">
                        <div class="recent-account-name">${this.esc(username)}</div>
                        <div class="recent-account-meta">${active ? 'текущий аккаунт' : this.esc(this.formatRecentAccountTime(account.lastUsedAt))}</div>
                    </div>
                    <div class="recent-account-actions">
                        <button class="btn-flat recent-account-switch" type="button" data-switch-account="${this.esc(username)}" ${active ? 'disabled' : ''}>${active ? 'Активен' : 'Войти'}</button>
                        <button class="btn-flat recent-account-remove" type="button" data-remove-recent-account="${this.esc(username)}" title="Убрать из быстрых аккаунтов">×</button>
                    </div>
                </div>
            `;
        }).join('');
        box.innerHTML = `<div class="recent-accounts-title">Недавние аккаунты</div>${rows}`;
    }

    async switchRecentAccount(username) {
        const key = String(username || '').trim().toLowerCase();
        if (!key) return;
        const account = this.loadRecentAccounts()
            .find(item => String(item.username || '').trim().toLowerCase() === key);
        if (!account?.token) {
            this.forgetRecentAccount(username);
            return;
        }
        if (this.isTokenExpired(account.token)) {
            this.forgetRecentAccountEntry(account.username, account.token);
            const expiredMsg = `Сохранённый вход ${account.username} истёк. Войдите заново.`;
            this.addLogEntry({ type: 'WARN', msg: expiredMsg, ts: new Date().toLocaleTimeString() });
            this.S.auth.error = expiredMsg;
            this.updateAuthView();
            return;
        }

        this.addLogEntry({ type: 'INFO', msg: `Входим как ${account.username}...`, ts: new Date().toLocaleTimeString() });
        // Токен проверен локально — применяем сессию напрямую без HTTP round-trip.
        // Если токен окажется невалидным на сервере, первый же API-запрос вернёт 401
        // и handleUnauthorizedApiResponse инвалидирует сессию.
        this.applySession({
            username: account.username,
            token: account.token,
            guest: false,
        }, { persist: true, syncNative: true });

        // Account switch must run the same post-auth setup as a normal login:
        // register the device, pull incoming key envelopes (so this account adopts
        // the peer's conversation key) and re-publish our own. Without this the
        // switched-in account cannot decrypt the peer's messages — they show up as
        // "🔒 зашифровано другим ключом".
        this.startPostAuthSetup({ reason: 'switchAccount', restoreStoredUnlockSecret: true });

        // Show the chat immediately. Previously the switch awaited loadContacts +
        // loadUsers + loadServers + key sync sequentially (4 round-trips) before
        // opening the chat, which caused a ~15s delay. None of the sidebar data is
        // needed to render the active conversation.
        this.openChatView();
        this.addLogEntry({ type: 'SUCCESS', msg: `Аккаунт переключён: ${this.myName()}`, ts: new Date().toLocaleTimeString() });

        // refreshAfterKey pulls incoming key envelopes, resolves the conversation key
        // and reloads the active chat history — this is the only thing needed to show
        // the peer's messages, so it runs on its own (non-blocking) path.
        void this.timeStage('switch→чат готов (refreshAfterKey)', () => this.refreshAfterKey());

        // Sidebar data fills in afterwards in the background.
        void Promise.allSettled([
            this.loadContacts(),
            this.loadUsers(),
            this.loadServers({ silent: true }),
        ]).then(() => this.renderRecentAccounts());
    }

    saveInjectedSession(session) {
        try {
            window.__ZALI_SAVED_SESSION = session && typeof session === 'object' ? session : null;
        } catch (e) {}
    }

    clearStoredSession() {
        try {
            localStorage.removeItem(this.authStorageKey());
            this.saveInjectedSession(null);
        } catch (e) {
            // ignore storage failures
        }
    }

    loadPendingOutbox() {
        try {
            const raw = localStorage.getItem(this.pendingOutboxStorageKey());
            if (!raw) {
                const injected = this.loadInjectedPendingOutbox();
                this.trace(`loadPendingOutbox local=no injected=${injected.length}`);
                return injected;
            }
            const parsed = JSON.parse(raw);
            this.trace(`loadPendingOutbox local=yes count=${Array.isArray(parsed) ? parsed.length : 0}`);
            return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : this.loadInjectedPendingOutbox();
        } catch (e) {
            this.trace('loadPendingOutbox error fallback injected');
            return this.loadInjectedPendingOutbox();
        }
    }

    savePendingOutbox(items) {
        const next = Array.isArray(items) ? items : [];
        try {
            localStorage.setItem(this.pendingOutboxStorageKey(), JSON.stringify(next));
        } catch (e) {
            this.trace(`savePendingOutbox localStorage failed reason=${e?.name || e?.message || e}`);
            this.warnStorageFallback('pending_outbox', `Не удалось сохранить очередь отправки в localStorage: ${e?.name || e?.message || e}`);
        }
        this.trace(`savePendingOutbox count=${next.length}`);
        this.saveInjectedPendingOutbox(next);
        if (this.nativeSupports('sessionSync')) {
            this.trace(`savePendingOutbox native sync count=${next.length}`);
            this.postNativeMessage({
                type: NativeMessageTypes.SAVE_PENDING_OUTBOX,
                items: next,
            });
        }
    }

    pendingOutboxNextRetryDelay() {
        const now = Date.now();
        const currentUser = String(this.myName() || '').trim();
        const pending = this.loadPendingOutbox()
            .filter(item => !currentUser || String(item?.sender || '').trim() === currentUser);
        if (!pending.length) return null;
        let nextDelay = Infinity;
        for (const item of pending) {
            const retryAt = Number(item?.nextRetryAt || 0);
            if (!retryAt) {
                nextDelay = 0;
                break;
            }
            const delta = Math.max(0, retryAt - now);
            if (delta < nextDelay) nextDelay = delta;
        }
        return Number.isFinite(nextDelay) ? nextDelay : null;
    }

    loadInjectedPendingOutbox() {
        try {
            const raw = window.__ZALI_PENDING_OUTBOX;
            if (!Array.isArray(raw)) return [];
            return raw.filter(item => item && typeof item === 'object');
        } catch (e) {
            return [];
        }
    }

    saveInjectedPendingOutbox(items) {
        try {
            window.__ZALI_PENDING_OUTBOX = Array.isArray(items) ? items : [];
        } catch (e) {}
    }

    warnStorageFallback(scope, message) {
        const key = String(scope || 'storage').trim();
        if (!key || this.storageWarningSeen.has(key)) return;
        this.storageWarningSeen.add(key);
        if (typeof this.addLogEntry === 'function') {
            this.addLogEntry({
                type: 'WARN',
                msg: message,
                ts: new Date().toLocaleTimeString(),
            });
        }
    }

    pendingOutboxConversationKey(item) {
        const serverId = String(item?.serverId || '').trim();
        const channelId = String(item?.channelId || '').trim();
        const sender = String(item?.sender || '').trim();
        const receiver = String(item?.receiver || '').trim();
        return serverId && channelId
            ? `server:${serverId}:${channelId}:${sender}:${receiver}`
            : `dm:${sender}:${receiver}`;
    }

    messageConversationKey(msg) {
        const serverId = String(msg?.serverId || msg?.server_id || '').trim();
        const channelId = String(msg?.channelId || msg?.channel_id || '').trim();
        const sender = String(msg?.sender || '').trim();
        const receiver = String(msg?.receiver || '').trim();
        return serverId && channelId
            ? `server:${serverId}:${channelId}:${sender}:${receiver}`
            : `dm:${sender}:${receiver}`;
    }

    pendingOutboxContentKey(item) {
        const attachmentsKey = this.normalizeAttachments(item?.attachments).map(att => `${att.name}:${att.kind}:${att.size}:${att.mimeType}`).join('|');
        return [
            String(item?.text || ''),
            attachmentsKey,
        ].join('::');
    }

    messageContentKey(msg) {
        const attachmentsKey = this.normalizeAttachments(msg?.attachments).map(att => `${att.name}:${att.kind}:${att.size}:${att.mimeType}`).join('|');
        const call = msg?.kind === 'call' ? msg.call || {} : {};
        return [
            String(msg?.kind || ''),
            String(msg?.text || ''),
            String(call.roomId || ''),
            String(call.direction || ''),
            String(call.outcome || ''),
            String(call.peer || ''),
            String(call.durationMs || ''),
            attachmentsKey,
        ].join('::');
    }

    matchPendingOutboxItem(msg) {
        const contentKey = this.messageContentKey(msg);
        const conversationKey = this.messageConversationKey(msg);
        const sender = String(msg?.sender || '').trim();
        const receiver = String(msg?.receiver || '').trim();
        const serverId = String(msg?.serverId || msg?.server_id || '').trim();
        const channelId = String(msg?.channelId || msg?.channel_id || '').trim();
        const pending = this.loadPendingOutbox();
        return pending.find(item => {
            if (!item || typeof item !== 'object') return false;
            if (this.pendingOutboxConversationKey(item) !== conversationKey) return false;
            if (String(item.sender || '').trim() !== sender) return false;
            if (String(item.receiver || '').trim() !== receiver) return false;
            if (serverId && String(item.serverId || '').trim() !== serverId) return false;
            if (channelId && String(item.channelId || '').trim() !== channelId) return false;
            return this.pendingOutboxContentKey(item) === contentKey;
        }) || null;
    }

    cachePendingOutboxAttachments(clientId, attachments) {
        const key = String(clientId || '').trim();
        if (!key) return;
        // localStorage persists outbox attachments without dataUrl (quota), so the
        // payload needed for a retry lives only in this in-session cache.
        const withData = this.normalizeAttachments(attachments).filter(att => att.dataUrl);
        if (!withData.length) return;
        if (!this._outboxAttachmentCache) this._outboxAttachmentCache = new Map();
        this._outboxAttachmentCache.set(key, withData);
    }

    getPendingOutboxAttachments(clientId) {
        const key = String(clientId || '').trim();
        if (!key || !this._outboxAttachmentCache) return [];
        return this._outboxAttachmentCache.get(key) || [];
    }

    enqueuePendingOutbox(message) {
        if (!message || typeof message !== 'object') return;
        const pending = this.loadPendingOutbox();
        const key = String(message.clientId || '').trim();
        if (!key) return;
        if (pending.some(item => String(item.clientId || '').trim() === key)) return;
        this.trace(`enqueuePendingOutbox clientId=${key} sender=${String(message.sender || '').trim()} receiver=${String(message.receiver || '').trim()} server=${String(message.serverId || '').trim()} channel=${String(message.channelId || '').trim()} textBytes=${String(message.text || '').length} attachments=${this.normalizeAttachments(message.attachments).length}`);
        pending.push({
            clientId: key,
            sender: String(message.sender || '').trim(),
            receiver: String(message.receiver || '').trim(),
            serverId: message.serverId ? String(message.serverId).trim() : '',
            channelId: message.channelId ? String(message.channelId).trim() : '',
            text: String(message.text || ''),
            attachments: this.normalizeAttachments(message.attachments).map(att => ({
                id: att.id,
                name: att.name,
                mimeType: att.mimeType,
                kind: att.kind,
                size: att.size,
                archivePath: att.archivePath,
            })),
            timestamp: String(message.timestamp || new Date().toISOString()),
            attemptCount: Number(message.attemptCount || 0),
            lastAttemptAt: Number(message.lastAttemptAt || 0),
            nextRetryAt: Number(message.nextRetryAt || 0),
            // Persist the encryption key (and its version) the optimistic message was
            // queued with. Previously this field was silently dropped, so every retry
            // re-derived the *current* conversation key via pendingOutboxItemKey — after
            // a key rotation a retry could ship under a different key than its bubble.
            key: message.key ? String(message.key) : '',
            keyVersion: Number(message.keyVersion || 2),
            inFlight: !!message.inFlight,
        });
        this.savePendingOutbox(pending);
    }

    updatePendingOutboxItem(clientId, patch = {}) {
        const pendingId = String(clientId || '').trim();
        if (!pendingId) return false;
        const pending = this.loadPendingOutbox();
        const index = pending.findIndex(item => String(item?.clientId || '').trim() === pendingId);
        if (index < 0) return false;
        pending[index] = {
            ...pending[index],
            ...(patch && typeof patch === 'object' ? patch : {}),
        };
        this.savePendingOutbox(pending);
        return true;
    }

    dropPendingOutbox(clientId) {
        const pendingId = String(clientId || '').trim();
        if (!pendingId) return;
        this.trace(`dropPendingOutbox clientId=${pendingId}`);
        this.clearSendWatchdog(pendingId);
        if (this._outboxAttachmentCache) this._outboxAttachmentCache.delete(pendingId);
        const pending = this.loadPendingOutbox().filter(item => String(item.clientId || '').trim() !== pendingId);
        this.savePendingOutbox(pending);
    }

    clearSendWatchdog(clientId) {
        const pendingId = String(clientId || '').trim();
        if (!pendingId) return;
        const timer = this.sendWatchdogTimers.get(pendingId);
        if (timer) {
            clearTimeout(timer);
            this.sendWatchdogTimers.delete(pendingId);
        }
    }

    scheduleSendWatchdog(message, key) {
        const clientId = String(message?.clientId || '').trim();
        if (!clientId) return;
        this.clearSendWatchdog(clientId);
        const timer = setTimeout(() => {
            this.sendWatchdogTimers.delete(clientId);
            const found = this.findMessageById(clientId);
            if (!found || String(found.msg?.status || '').trim() !== 'sending') return;
            const pending = this.loadPendingOutbox();
            const existing = pending.find(item => String(item?.clientId || '').trim() === clientId);
            if (!existing) {
                this.trace(`sendWatchdog requeue clientId=${clientId}`);
                this.enqueuePendingOutbox({
                    ...message,
                    key: '',
                    nextRetryAt: 0,
                    attemptCount: (message.attemptCount || 0) + 1,
                    lastAttemptAt: 0,
                });
                this.scheduleFlushPendingOutbox(150);
                return;
            }
            this.updatePendingOutboxItem(clientId, {
                inFlight: false,
                nextRetryAt: Date.now(),
            });
            this.scheduleFlushPendingOutbox(150);
        }, 20000);
        this.sendWatchdogTimers.set(clientId, timer);
    }

    scheduleFlushPendingOutbox(delayMs = 150) {
        if (this.pendingOutboxFlushTimer) {
            clearTimeout(this.pendingOutboxFlushTimer);
        }
        this.pendingOutboxFlushTimer = setTimeout(() => {
            this.pendingOutboxFlushTimer = null;
            this.flushPendingOutbox();
        }, Math.max(0, Number(delayMs || 0)));
    }

    rehydratePendingOutbox() {
        const currentUser = String(this.myName() || '').trim();
        if (!currentUser) return;
        const pending = this.loadPendingOutbox().filter(item => String(item?.sender || '').trim() === currentUser);
        this.trace(`rehydratePendingOutbox currentUser=${currentUser} count=${pending.length} tokenSet=${!!this.S.session?.token} navMode=${this.S.navMode}`);
        let changed = false;

        for (const item of pending) {
            if (!item || typeof item !== 'object') continue;
            const clientId = String(item.clientId || '').trim();
            if (!clientId) continue;
            if (this.findMessageById(clientId)) continue;

            const serverId = String(item.serverId || '').trim();
            const channelId = String(item.channelId || '').trim();
            const isServers = !!(serverId && channelId);
            const conversationKey = isServers ? `${serverId}:${channelId}` : String(item.receiver || '').trim();
            const message = {
                id: clientId,
                sender: String(item.sender || currentUser).trim() || currentUser,
                receiver: String(item.receiver || '').trim(),
                text: String(item.text || ''),
                attachments: this.normalizeAttachments(item.attachments),
                timestamp: String(item.timestamp || new Date().toISOString()),
                status: 'sending',
                clientId,
                serverId: isServers ? serverId : null,
                channelId: isServers ? channelId : null,
            };

            if (isServers) {
                if (!this.S.serverChats[conversationKey]) this.S.serverChats[conversationKey] = [];
                this.S.serverChats[conversationKey].push(message);
            } else {
                this.ensureContact(message.receiver);
                this.initChat(message.receiver);
                this.S.chats[message.receiver].push(message);
            }
            changed = true;
        }

        if (changed) {
            if (this.S.navMode !== 'servers') {
                const currentKey = String(this.S.current || '').trim();
                const currentMsgs = currentKey ? (this.S.chats[currentKey] || []) : [];
                if (!currentKey || !currentMsgs.length) {
                    const preferredPeer = pending
                        .map(item => String(item?.receiver || '').trim())
                        .find(peer => peer && (this.S.chats[peer] || []).length > 0);
                    if (preferredPeer && preferredPeer !== this.S.current) {
                        this.switchChat(preferredPeer);
                    }
                }
            }
            this.scheduleRenderMessages();
            this.renderContacts();
            this.renderServerInterface();
        }
    }

    recoverOrphanSendingMessages() {
        const currentUser = String(this.myName() || '').trim();
        if (!currentUser || !this.S.session?.token) return;
        const maxAgeMs = 2 * 60 * 60 * 1000;
        const now = Date.now();
        const pendingIds = new Set(this.loadPendingOutbox().map(item => String(item?.clientId || '').trim()).filter(Boolean));
        let recovered = 0;

        const shouldRecover = (msg) => {
            const clientId = String(msg?.clientId || '').trim();
            if (!clientId || pendingIds.has(clientId)) return false;
            if (String(msg?.sender || '').trim() !== currentUser) return false;
            if (String(msg?.status || '').trim() !== 'sending') return false;
            const timestamp = Date.parse(String(msg?.timestamp || ''));
            if (!Number.isFinite(timestamp) || (now - timestamp) > maxAgeMs) return false;
            return true;
        };

        const recoverMessage = (msg, serverId = null, channelId = null) => {
            const receiver = String(msg?.receiver || '').trim();
            if (!receiver) return;
            const key = serverId && channelId
                ? this.ensureConversationCryptoKey({ serverId, channelId, reason: 'recoverOrphanSendingMessages' })
                : this.ensureConversationCryptoKey({ peer: receiver, reason: 'recoverOrphanSendingMessages' });
            this.cachePendingOutboxAttachments(msg?.clientId, msg?.attachments);
            this.enqueuePendingOutbox({
                ...msg,
                receiver,
                serverId: serverId || null,
                channelId: channelId || null,
                key,
                keyVersion: Number(msg?.keyVersion || 2),
                nextRetryAt: 0,
                attemptCount: 0,
                lastAttemptAt: 0,
            });
            this.scheduleSendWatchdog(msg, key);
            recovered += 1;
        };

        for (const msgs of Object.values(this.S.chats || {})) {
            for (const msg of Array.isArray(msgs) ? msgs : []) {
                if (shouldRecover(msg)) recoverMessage(msg);
            }
        }
        for (const [key, msgs] of Object.entries(this.S.serverChats || {})) {
            const [serverId, channelId] = String(key || '').split(':');
            if (!serverId || !channelId) continue;
            for (const msg of Array.isArray(msgs) ? msgs : []) {
                if (shouldRecover(msg)) recoverMessage(msg, serverId, channelId);
            }
        }

        if (recovered > 0) {
            this.trace(`recoverOrphanSendingMessages recovered=${recovered}`);
            this.addLogEntry({ type: 'WARN', msg: `Восстановлено зависших сообщений: ${recovered}`, ts: new Date().toLocaleTimeString() });
            this.scheduleFlushPendingOutbox(150);
        }
    }

    isPendingMessageAlreadyLoaded(item) {
        const clientId = String(item.clientId || '').trim();
        const attachmentsKey = this.normalizeAttachments(item.attachments).map(att => `${att.name}:${att.kind}:${att.size}`).join('|');
        const text = String(item.text || '');
        const sender = String(item.sender || '');
        const receiver = String(item.receiver || '');
        const serverId = String(item.serverId || '').trim();
        const channelId = String(item.channelId || '').trim();

        const matchesDelivered = (msg) => {
            if (String(msg.status || '').trim() !== 'sent') return false;
            if (msg.error) return false;
            if (clientId) {
                // Only the same clientId echoed back by the server proves delivery.
                // Content equality is not proof: two distinct messages with identical
                // text/attachments would wrongly drop the second one from the outbox,
                // leaving its bubble stuck in "sending" forever.
                return String(msg.clientId || msg.client_id || '').trim() === clientId;
            }
            const msgAttachments = this.normalizeAttachments(msg.attachments).map(att => `${att.name}:${att.kind}:${att.size}`).join('|');
            return String(msg.sender || '') === sender &&
                String(msg.receiver || '') === receiver &&
                String(msg.text || '') === text &&
                msgAttachments === attachmentsKey;
        };

        if (serverId && channelId) {
            const msgs = this.S.serverChats[`${serverId}:${channelId}`] || [];
            return msgs.some(matchesDelivered);
        }

        const peer = sender === this.myName() ? receiver : sender;
        return (this.S.chats[peer] || []).some(matchesDelivered);
    }

    flushPendingOutbox() {
        if (!this.nativeSupports('sendMessage')) return;
        if (!this.S.session?.token) return;
        const currentUser = String(this.myName() || '').trim();
        const now = Date.now();
        const pending = this.loadPendingOutbox();
        if (!pending.length) return;
        this.trace(`flushPendingOutbox currentUser=${currentUser} count=${pending.length} tokenSet=${!!this.S.session?.token}`);
        let sentAny = false;

        // Cap concurrent sends. Firing the whole backlog at once saturates the
        // connection pool to the host, which makes unrelated API calls (device trust,
        // contacts, key sync) queue behind it and time out at 12s. The rest of the
        // queue goes out on the next flush cycle.
        const MAX_CONCURRENT_SENDS = 3;
        let inFlightCount = pending.reduce((n, it) => n + (it && it.inFlight ? 1 : 0), 0);

        for (const item of pending) {
            if (!item || typeof item !== 'object') continue;
            if (currentUser && String(item.sender || '').trim() !== currentUser) continue;
            if (Number(item.nextRetryAt || 0) > now) continue;
            if (item.inFlight) {
                // A native send result can get lost (bridge reloaded mid-send, response
                // dropped). Without this, the item stays inFlight forever and the message
                // is only retried after a WS reconnect kick or app restart.
                const stalledMs = now - Number(item.lastAttemptAt || 0);
                if (!Number.isFinite(stalledMs) || stalledMs < 45000) continue;
                this.trace(`flushPendingOutbox stalled inFlight cleared clientId=${String(item.clientId || '').trim()} stalledMs=${Math.round(stalledMs)}`);
                item.inFlight = false;
                // Reclaim the concurrency slot this stalled item was holding. Without
                // this, when MAX_CONCURRENT_SENDS items are all stalled at once,
                // inFlightCount never drops below the cap, so the throttle check below
                // always breaks the loop — the queue deadlocks and nothing is retried.
                inFlightCount = Math.max(0, inFlightCount - 1);
            }
            if (inFlightCount >= MAX_CONCURRENT_SENDS) {
                this.trace(`flushPendingOutbox throttled inFlight=${inFlightCount} cap=${MAX_CONCURRENT_SENDS}`);
                this.scheduleFlushPendingOutbox(800);
                break;
            }

            const itemKey = this.pendingOutboxItemKey(item);
            if (!itemKey) {
                this.trace(`flushPendingOutbox missing key clientId=${String(item.clientId || '').trim()}`);
                item.nextRetryAt = now + 5000;
                this.savePendingOutbox(pending);
                continue;
            }

            const MAX_OUTBOX_ATTEMPTS = 50;
            if ((item.attemptCount || 0) >= MAX_OUTBOX_ATTEMPTS) {
                this.markMessageStatus(item.clientId, 'error');
                this.dropPendingOutbox(item.clientId);
                continue;
            }

            if (this.isPendingMessageAlreadyLoaded(item)) {
                this.dropPendingOutbox(item.clientId);
                continue;
            }

            const declaredAttachments = this.normalizeAttachments(item.attachments);
            let outAttachments = declaredAttachments.filter(att => att.dataUrl);
            if (declaredAttachments.length && !outAttachments.length) {
                outAttachments = this.getPendingOutboxAttachments(item.clientId).filter(att => att.dataUrl);
            }
            if (declaredAttachments.length && !outAttachments.length) {
                // The attachment bytes are gone (dataUrl is not persisted across
                // restarts). Sending now would deliver the message without its files —
                // or completely empty for attachment-only messages. Fail it visibly
                // instead of silently delivering wrong content.
                this.trace(`flushPendingOutbox attachments lost clientId=${String(item.clientId || '').trim()} declared=${declaredAttachments.length}`);
                this.markMessageStatus(item.clientId, 'error');
                this.dropPendingOutbox(item.clientId);
                this.addLogEntry({ type: 'ERROR', msg: 'Вложения сообщения утеряны после перезапуска, отправка отменена. Прикрепите файлы заново.', ts: new Date().toLocaleTimeString() });
                continue;
            }

            item.attemptCount = Number(item.attemptCount || 0) + 1;
            item.lastAttemptAt = now;
            item.nextRetryAt = now + Math.min(30000, Math.max(1500, 1000 * Math.min(item.attemptCount, 6)));
            item.inFlight = true;
            inFlightCount += 1;
            this.savePendingOutbox(pending);
            sentAny = true;

            const sentToNative = this.postNativeMessage({
                type: NativeMessageTypes.SEND_MESSAGE,
                text: item.text,
                recipient: item.serverId && item.channelId ? item.channelId : item.receiver,
                serverId: item.serverId || '',
                channelId: item.channelId || '',
                sender: item.sender || this.myName(),
                key: itemKey,
                keyVersion: Number(item.keyVersion || 2),
                clientId: item.clientId,
                attachments: outAttachments.map(att => ({
                    name: att.name,
                    mimeType: att.mimeType,
                    kind: att.kind,
                    size: att.size,
                    dataUrl: att.dataUrl,
                })),
            });
            if (!sentToNative) {
                this.trace(`flushPendingOutbox native bridge rejected clientId=${String(item.clientId || '').trim()}`);
                item.inFlight = false;
                inFlightCount -= 1;
                item.nextRetryAt = Date.now() + 2000;
                this.savePendingOutbox(pending);
            }
            this.trace(`flushPendingOutbox send clientId=${String(item.clientId || '').trim()} receiver=${String(item.receiver || '').trim()} server=${String(item.serverId || '').trim()} channel=${String(item.channelId || '').trim()} attempt=${item.attemptCount}`);
        }

        const nextDelay = this.pendingOutboxNextRetryDelay();
        if (nextDelay !== null && this.loadPendingOutbox().some(item => String(item?.sender || '').trim() === currentUser)) {
            this.scheduleFlushPendingOutbox(Math.max(150, sentAny ? Math.min(3000, nextDelay) : nextDelay));
        }
    }

    pendingOutboxItemKey(item) {
        const stored = String(item?.key || '').trim();
        if (stored) return stored;
        const serverId = String(item?.serverId || '').trim();
        const channelId = String(item?.channelId || '').trim();
        const receiver = String(item?.receiver || item?.recipient || '').trim();
        try {
            if (serverId && channelId) {
                return this.ensureConversationCryptoKey({ serverId, channelId, reason: 'pendingOutboxItemKey' });
            }
            if (receiver) {
                return this.ensureConversationCryptoKey({ peer: receiver, reason: 'pendingOutboxItemKey' });
            }
            return this._getKey();
        } catch (e) {
            return '';
        }
    }

    clearLastStoredSession() {
        try {
            localStorage.removeItem(this.lastAuthStorageKey());
        } catch (e) {
            // ignore storage failures
        }
    }

    loadStoredNavMode() {
        try {
            const raw = localStorage.getItem(this.navModeStorageKey());
            return raw === 'servers' ? 'servers' : 'dm';
        } catch (e) {
            return 'dm';
        }
    }

    saveStoredNavMode(mode) {
        try {
            localStorage.setItem(this.navModeStorageKey(), mode);
        } catch (e) {
            // ignore storage failures
        }
    }

    loadStoredActiveServer() {
        try {
            const raw = localStorage.getItem(this.activeServerStorageKey());
            return raw ? String(raw) : null;
        } catch (e) {
            return null;
        }
    }

    saveStoredActiveServer(serverId) {
        try {
            if (serverId) {
                localStorage.setItem(this.activeServerStorageKey(), serverId);
            } else {
                localStorage.removeItem(this.activeServerStorageKey());
            }
        } catch (e) {
            // ignore storage failures
        }
    }

    loadStoredActiveChannel() {
        try {
            const raw = localStorage.getItem(this.activeChannelStorageKey());
            return raw ? String(raw) : null;
        } catch (e) {
            return null;
        }
    }

    saveStoredActiveChannel(channelId) {
        try {
            if (channelId) {
                localStorage.setItem(this.activeChannelStorageKey(), channelId);
            } else {
                localStorage.removeItem(this.activeChannelStorageKey());
            }
        } catch (e) {
            // ignore storage failures
        }
    }

    loadStoredServerChats() {
        return {};
    }

    saveStoredServerChats() {
        // Server history now comes from the backend; keep this as a no-op
        // so local optimistic state doesn't get duplicated after restart.
    }

    loadStoredMutedChats() {
        try {
            const raw = localStorage.getItem(this.mutedChatsStorageKey());
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    saveStoredMutedChats() {
        try {
            localStorage.setItem(this.mutedChatsStorageKey(), JSON.stringify(this.S.mutedChats || {}));
        } catch (e) {
            // ignore storage failures
        }
    }

    loadStoredNetworkConfig() {
        try {
            const raw = localStorage.getItem(this.networkConfigStorageKey());
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    isDefaultableNetworkUrl(value) {
        const raw = String(value || '').trim().toLowerCase();
        if (!raw) return true;
        return (
            raw.startsWith('http://localhost') ||
            raw.startsWith('https://localhost') ||
            raw.startsWith('http://127.0.0.1') ||
            raw.startsWith('https://127.0.0.1') ||
            raw.startsWith('http://[::1]') ||
            raw.startsWith('https://[::1]') ||
            raw.startsWith('http://89.108.76.89:3000') ||
            raw.startsWith('https://89.108.76.89:3000')
        );
    }

    trimTrailingSlash(value) {
        return String(value || '').trim().replace(/\/+$/, '');
    }

    isPlaceholderNetworkUrl(value) {
        const raw = String(value || '').trim().toLowerCase();
        if (!raw) return false;
        return (
            raw.includes('chat.example.com') ||
            raw.includes('turn.example.com') ||
            raw.includes('example.com')
        );
    }

    normalizeLocalApiAddress(value) {
        const raw = this.trimTrailingSlash(value);
        if (!raw) return '';
        try {
            const parsed = new URL(raw);
            const host = parsed.hostname.toLowerCase();
            const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(host);
            if (isLocalHost && !parsed.port) {
                parsed.port = '3000';
            }
            if (host === 'localhost' || host === '::1') {
                parsed.hostname = '127.0.0.1';
            }
            return parsed.toString().replace(/\/$/, '');
        } catch (e) {
            if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?:[\/?#]|$)/i.test(raw) && !/:\d+(?:[\/?#]|$)/.test(raw)) {
                return raw
                    .replace(/^(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?=[:\/?#]|$)/i, '$1:3000')
                    .replace(/^https?:\/\/(?:localhost|\[::1\])(?=:3000(?:[\/?#]|$))/i, 'http://127.0.0.1');
            }
            if (/^https?:\/\/(?:localhost|\[::1\])(?=[:\/?#]|$)/i.test(raw)) {
                return raw.replace(
                    /^(https?:\/\/)(?:localhost|\[::1\])(?=[:\/?#]|$)/i,
                    '$1127.0.0.1'
                );
            }
            return raw;
        }
    }

    normalizeApiBaseUrl(value) {
        const normalized = this.normalizeLocalApiAddress(value);
        if (!normalized) return '';
        if (this.isPlaceholderNetworkUrl(normalized)) return '';
        return normalized;
    }

    normalizeWsBaseUrl(value) {
        const normalized = this.trimTrailingSlash(value);
        if (!normalized) return '';
        if (this.isPlaceholderNetworkUrl(normalized)) return '';
        return normalized;
    }

    saveStoredNetworkConfig(config) {
        try {
            localStorage.setItem(this.networkConfigStorageKey(), JSON.stringify(config || {}));
        } catch (e) {
            // ignore storage failures
        }
    }

    hasStoredNetworkConfig() {
        try {
            return !!localStorage.getItem(this.networkConfigStorageKey());
        } catch (e) {
            return false;
        }
    }

    defaultApiBaseUrl() {
        if (window.__ZALI_CONFIG?.apiBaseUrl) {
            return this.normalizeApiBaseUrl(window.__ZALI_CONFIG.apiBaseUrl);
        }
        return 'https://msgs.zalikus.org';
    }

    defaultWsBaseUrl() {
        if (window.__ZALI_CONFIG?.wsBaseUrl) {
            return this.normalizeWsBaseUrl(window.__ZALI_CONFIG.wsBaseUrl);
        }
        const api = this.defaultApiBaseUrl();
        if (api.startsWith('https://')) return api.replace(/^https:\/\//, 'wss://') + '/ws';
        if (api.startsWith('http://')) return api.replace(/^http:\/\//, 'ws://') + '/ws';
        return 'wss://msgs.zalikus.org/ws';
    }

    deriveWsBaseUrl(apiBaseUrl) {
        const api = this.normalizeApiBaseUrl(apiBaseUrl || '');
        if (api.startsWith('https://')) return api.replace(/^https:\/\//, 'wss://') + '/ws';
        if (api.startsWith('http://')) return api.replace(/^http:\/\//, 'ws://') + '/ws';
        return this.defaultWsBaseUrl();
    }

    defaultTurnUrls() {
        const fromConfig = window.__ZALI_CONFIG?.turn?.url;
        if (fromConfig) {
            const urls = Array.isArray(fromConfig) ? fromConfig : [fromConfig];
            return urls.map(item => String(item || '').trim()).filter(Boolean);
        }

        const stored = this.loadStoredNetworkConfig();
        const apiBase = this.normalizeApiBaseUrl(stored.apiBaseUrl || '') || this.defaultApiBaseUrl();
        let host = '127.0.0.1';
        try {
            host = new URL(apiBase).hostname || host;
        } catch (e) {}

        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
            return [
                'turn:127.0.0.1:3478?transport=udp',
                'turn:127.0.0.1:3478?transport=tcp',
                'turn:localhost:3478?transport=udp',
                'turn:localhost:3478?transport=tcp',
            ];
        }

        const safeHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
        return [
            `turn:${safeHost}:3478?transport=udp`,
            `turn:${safeHost}:3478?transport=tcp`,
        ];
    }

    defaultIceServers() {
        const injected = window.__ZALI_CONFIG?.iceServers;
        if (Array.isArray(injected) && injected.length) {
            return injected;
        }
        const turnConfig = window.__ZALI_CONFIG?.turn;
        if (turnConfig && turnConfig.url) {
            const urls = Array.isArray(turnConfig.url) ? turnConfig.url : [turnConfig.url];
            const turnServer = {
                urls: urls.map(item => String(item || '').trim()).filter(Boolean),
            };
            if (turnServer.urls.length) {
                if (turnConfig.username) turnServer.username = String(turnConfig.username).trim();
                if (turnConfig.credential) turnServer.credential = String(turnConfig.credential).trim();
                if (turnConfig.relayOnly !== undefined) turnServer.relayOnly = !!turnConfig.relayOnly;
                const servers = [turnServer];
                if (!turnServer.relayOnly) {
                    servers.push(
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' },
                    );
                }
                return servers;
            }
        }
        return [
            {
                urls: this.defaultTurnUrls(),
                username: 'zali',
                credential: 'turnpass',
            },
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ];
    }

    defaultTurnPreset() {
        const turn = window.__ZALI_CONFIG?.turn || {};
        const defaultUrls = this.defaultTurnUrls().join(', ');
        return {
            url: String(turn.url || defaultUrls).trim(),
            username: String(turn.username || 'zali').trim(),
            credential: String(turn.credential || 'turnpass').trim(),
            relayOnly: turn.relayOnly !== undefined ? !!turn.relayOnly : false,
        };
    }

    normalizeIceServers(value) {
        const list = Array.isArray(value) ? value : [];
        return list.map(item => {
            if (typeof item === 'string') {
                return { urls: item.trim() };
            }
            if (item && typeof item === 'object') {
                const urls = Array.isArray(item.urls) ? item.urls : item.urls ? [item.urls] : [];
                const next = { ...item, urls: urls.map(url => String(url || '').trim()).filter(Boolean) };
                return next.urls.length ? next : null;
            }
            return null;
        }).filter(Boolean);
    }

    parseIceServersText(raw) {
        const text = String(raw || '').trim();
        if (!text) return [];
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
            throw new Error('ICE servers должен быть JSON-массивом');
        }
        return this.normalizeIceServers(parsed);
    }

    loadNetworkConfig() {
        const stored = this.loadStoredNetworkConfig();
        const storedApiBaseUrl = this.normalizeApiBaseUrl(stored.apiBaseUrl || '');
        const storedWsBaseUrl = this.normalizeWsBaseUrl(stored.wsBaseUrl || '');
        const useDefaultApi = this.isDefaultableNetworkUrl(storedApiBaseUrl);
        const apiBaseUrl = useDefaultApi ? this.defaultApiBaseUrl() : (storedApiBaseUrl || this.defaultApiBaseUrl());
        const wsBaseUrl = useDefaultApi
            ? this.defaultWsBaseUrl()
            : (storedWsBaseUrl || this.defaultWsBaseUrl());
        let iceServers = this.normalizeIceServers(stored.iceServers);
        if (!iceServers.length) {
            iceServers = this.normalizeIceServers(this.defaultIceServers());
        }
        return { apiBaseUrl, wsBaseUrl, iceServers };
    }

    getApiBaseUrl() {
        return this.loadNetworkConfig().apiBaseUrl;
    }

    getWsBaseUrl() {
        return this.loadNetworkConfig().wsBaseUrl;
    }

    getIceServers() {
        return this.loadNetworkConfig().iceServers;
    }

    getVoiceRtcConfig() {
        const config = this.loadNetworkConfig();
        const defaultTurn = {
            urls: this.defaultTurnUrls(),
            username: 'zali',
            credential: 'turnpass',
        };
        const iceServers = this.normalizeIceServers([defaultTurn, ...config.iceServers]);
        const seenUrls = new Set();
        const uniqueServers = iceServers.map(server => {
            const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
            const nextUrls = urls
                .map(url => String(url || '').trim())
                .filter(Boolean)
                .filter(url => {
                    const key = url.toLowerCase();
                    if (seenUrls.has(key)) return false;
                    seenUrls.add(key);
                    return true;
                });
            return nextUrls.length ? { ...server, urls: nextUrls } : null;
        }).filter(Boolean);
        return {
            iceServers: uniqueServers.map(server => {
                const { relayOnly, ...iceServer } = server || {};
                return iceServer;
            }),
            iceCandidatePoolSize: 4,
            iceTransportPolicy: 'all',
        };
    }

    apiUrl(path = '') {
        const base = String(this.getApiBaseUrl() || '').trim().replace(/\/+$/, '');
        const nextPath = String(path || '').trim();
        if (!base) return nextPath;
        if (!nextPath) return base;
        return `${base}${nextPath.startsWith('/') ? nextPath : `/${nextPath}`}`;
    }

    setNetworkConfig(config = {}) {
        const next = {
            apiBaseUrl: this.normalizeApiBaseUrl(config.apiBaseUrl || ''),
            wsBaseUrl: this.normalizeWsBaseUrl(config.wsBaseUrl || ''),
            iceServers: this.normalizeIceServers(config.iceServers),
        };
        this.saveStoredNetworkConfig(next);
        this.applyNetworkConfigToInputs();
        this.syncNativeNetworkConfig({ force: true });
        this.connectBrowserVoiceSocket();
        this.addLogEntry({ type: 'SUCCESS', msg: 'Network configuration updated', ts: new Date().toLocaleTimeString() });
    }

    resetNetworkConfig() {
        try {
            localStorage.removeItem(this.networkConfigStorageKey());
        } catch (e) {}
        this.applyNetworkConfigToInputs();
        this.syncNativeNetworkConfig({ force: true });
        this.connectBrowserVoiceSocket();
        this.addLogEntry({ type: 'WARN', msg: 'Network configuration reset to defaults', ts: new Date().toLocaleTimeString() });
    }

    applyNetworkConfigToInputs() {
        const config = this.loadNetworkConfig();
        const apiInput = document.getElementById('inputApiBaseUrl');
        const wsInput = document.getElementById('inputWsBaseUrl');
        const iceInput = document.getElementById('inputIceServers');
        const turnUrlInput = document.getElementById('inputTurnUrl');
        const turnUsernameInput = document.getElementById('inputTurnUsername');
        const turnCredentialInput = document.getElementById('inputTurnCredential');
        const turnRelayOnlyInput = document.getElementById('inputTurnRelayOnly');
        if (apiInput) apiInput.value = config.apiBaseUrl;
        if (wsInput) wsInput.value = config.wsBaseUrl;
        if (iceInput) iceInput.value = JSON.stringify(config.iceServers, null, 2);
        const turn = this.defaultTurnPreset();
        if (turnUrlInput) turnUrlInput.value = turn.url;
        if (turnUsernameInput) turnUsernameInput.value = turn.username;
        if (turnCredentialInput) turnCredentialInput.value = turn.credential;
        if (turnRelayOnlyInput) turnRelayOnlyInput.checked = turn.relayOnly;
        const authApiInput = document.getElementById('authApiBaseUrl');
        const authNote = document.getElementById('authNetworkNote');
        if (authApiInput && document.activeElement !== authApiInput && authApiInput.dataset.dirty !== '1') {
            authApiInput.value = config.apiBaseUrl;
        }
        if (authNote) {
            authNote.textContent = `Текущий API: ${config.apiBaseUrl || 'не задан'}`;
        }
    }

    syncAuthNetworkInput({ force = false } = {}) {
        const authApiInput = document.getElementById('authApiBaseUrl');
        const authNote = document.getElementById('authNetworkNote');
        if (!authApiInput) return;
        const config = this.loadNetworkConfig();
        const isTyping = document.activeElement === authApiInput;
        const isDirty = authApiInput.dataset.dirty === '1';
        if (force || (!isTyping && !isDirty)) {
            authApiInput.value = config.apiBaseUrl;
        }
        if (authNote) {
            authNote.textContent = `Текущий API: ${config.apiBaseUrl || 'не задан'}`;
        }
    }

    buildTurnIceServerFromInputs() {
        const turnUrlInput = document.getElementById('inputTurnUrl');
        const turnUsernameInput = document.getElementById('inputTurnUsername');
        const turnCredentialInput = document.getElementById('inputTurnCredential');
        const turnRelayOnlyInput = document.getElementById('inputTurnRelayOnly');
        const urls = String(turnUrlInput?.value || '').trim();
        if (!urls) {
            throw new Error('Укажите TURN URL');
        }
        const urlList = urls.split(',').map(item => item.trim()).filter(Boolean);
        if (!urlList.length) {
            throw new Error('TURN URL не должен быть пустым');
        }
        const entry = {
            urls: urlList.length === 1 ? urlList[0] : urlList,
        };
        const username = String(turnUsernameInput?.value || '').trim();
        const credential = String(turnCredentialInput?.value || '').trim();
        if (username) entry.username = username;
        if (credential) entry.credential = credential;
        if (turnRelayOnlyInput) entry.relayOnly = !!turnRelayOnlyInput.checked;
        return entry;
    }

    appendTurnPresetToIceServers(baseIceServers = null) {
        const iceInput = document.getElementById('inputIceServers');
        const current = Array.isArray(baseIceServers)
            ? this.normalizeIceServers(baseIceServers)
            : this.normalizeIceServers(this.loadNetworkConfig().iceServers);
        const turnEntry = this.buildTurnIceServerFromInputs();
        const next = [...current.filter(server => {
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
            const turnUrls = Array.isArray(turnEntry.urls) ? turnEntry.urls : [turnEntry.urls];
            return !urls.some(url => turnUrls.includes(url));
        }), turnEntry];
        if (iceInput) {
            iceInput.value = JSON.stringify(next, null, 2);
        }
        return next;
    }

    syncNativeNetworkConfig({ force = false } = {}) {
        if (!this.nativeSupports('networkConfig')) return;
        const injected = window.__ZALI_CONFIG || {};
        const hasInjectedNetworkConfig = !!(injected.apiBaseUrl || injected.wsBaseUrl || (Array.isArray(injected.iceServers) && injected.iceServers.length));
        if (!force && !this.hasStoredNetworkConfig() && !hasInjectedNetworkConfig) return;
        const config = this.loadNetworkConfig();
        try {
            this.postNativeMessage({
                type: NativeMessageTypes.NETWORK_CONFIG,
                apiBaseUrl: config.apiBaseUrl,
                wsBaseUrl: config.wsBaseUrl,
                iceServers: config.iceServers,
            });
        } catch (error) {
            this.addLogEntry({
                type: 'WARN',
                msg: `Не удалось синхронизировать сеть с native app: ${error?.message || error}`,
                ts: new Date().toLocaleTimeString(),
            });
        }
    }

    getDefaultServers() {
        return [];
    }

    defaultServerChannels(serverId) {
        const sid = String(serverId || '').trim();
        return [
            { id: `${sid}-general`, name: 'general', topic: 'Общий чат', kind: 'text', position: 0 },
            { id: `${sid}-voice`, name: 'voice', topic: 'Голосовой канал', kind: 'voice', position: 1 },
        ];
    }

    ensureServerChannels(server = {}) {
        const next = { ...server };
        const channels = Array.isArray(next.channels) ? next.channels.filter(Boolean).map(channel => ({ ...channel })) : [];
        if (!channels.length && next.id) {
            next.channels = this.defaultServerChannels(next.id);
            return next;
        }
        next.channels = channels.map((channel, index) => ({
            ...channel,
            kind: String(channel.kind || 'text').trim().toLowerCase() || 'text',
            position: Number.isFinite(Number(channel.position)) ? Number(channel.position) : index,
        })).sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
        return next;
    }

    ensureServersState() {
        this.S.servers = Array.isArray(this.S.servers)
            ? this.S.servers.map(server => this.ensureServerChannels(server))
            : [];
        const stored = this.loadStoredActiveServer();
        if (stored && this.S.servers.some(s => s.id === stored)) {
            this.S.activeServer = stored;
        } else if (!this.S.servers.some(s => s.id === this.S.activeServer)) {
            this.S.activeServer = null;
            this.S.activeChannel = null;
        }
    }

    updateSidebarModeLabel() {
        const label = document.querySelector('.nav-label');
        if (label) {
            label.textContent = this.S.navMode === 'servers' ? 'Сервера' : 'Диалоги';
        }
    }

    updateNavModeButtons() {
        const dmBtn = document.getElementById('modeDmBtn');
        const serversBtn = document.getElementById('modeServersBtn');
        const isServers = this.S.navMode === 'servers';
        if (dmBtn) {
            dmBtn.classList.toggle('active', !isServers);
            dmBtn.setAttribute('aria-pressed', String(!isServers));
        }
        if (serversBtn) {
            serversBtn.classList.toggle('active', isServers);
            serversBtn.setAttribute('aria-pressed', String(isServers));
        }
        document.body?.setAttribute('data-nav-mode', this.S.navMode);
        const viewChat = document.getElementById('viewChat');
        if (viewChat) viewChat.classList.toggle('server-mode', isServers);
        this.updateSidebarModeLabel();
        this.renderHubSegmentNav();
    }

    normalizeServers(servers) {
        return Array.isArray(servers) ? servers.map(server => ({
            ...server,
            channels: Array.isArray(server.channels) && server.channels.length ? server.channels.map(channel => ({ ...channel })) : [],
            myRole: server.myRole || server.my_role || null,
            memberCount: Number(server.memberCount || server.member_count || 0) || 0,
            joinLink: server.joinLink || server.join_link || '',
        })).map(server => this.ensureServerChannels(server)).filter(Boolean) : [];
    }

    normalizeMemberRole(role) {
        const value = String(role || '').trim().toLowerCase();
        if (value === 'owner') return 'owner';
        if (value === 'admin') return 'admin';
        return 'member';
    }

    roleLabel(role) {
        switch (this.normalizeMemberRole(role)) {
            case 'owner': return 'Владелец';
            case 'admin': return 'Админ';
            default: return 'Участник';
        }
    }

    serverRoleLabel(roleId) {
        const role = String(roleId || '').trim();
        if (!role) return 'Участник';
        if (role === 'owner') return 'Владелец';
        if (role === 'admin') return 'Админ';
        if (role === 'member') return 'Участник';
        const found = (this.S.serverModal.roles || []).find(item => String(item.roleId || '') === role);
        return found?.name || role;
    }

    serverRoleList() {
        return Array.isArray(this.S.serverModal.roles) ? this.S.serverModal.roles : [];
    }

    draftServerRoleList() {
        return Array.isArray(this.S.serverModal.draftRoles) ? this.S.serverModal.draftRoles : [];
    }

    serverRolePermissionDefs() {
        return [
            { key: 'can_view', label: 'Чтение каналов', hint: 'Видеть список и историю сообщений', group: 'Доступ', defaultCreate: true },
            { key: 'can_send', label: 'Отправка сообщений', hint: 'Писать в текстовые каналы', group: 'Доступ', defaultCreate: true },
            { key: 'can_react', label: 'Реакции', hint: 'Ставить реакции на сообщения', group: 'Доступ', defaultCreate: true },
            { key: 'can_attach', label: 'Файлы', hint: 'Прикреплять изображения и файлы', group: 'Доступ', defaultCreate: true },
            { key: 'can_embed', label: 'Ссылки и медиа', hint: 'Встраивать превью ссылок', group: 'Доступ', defaultCreate: true },
            { key: 'can_voice', label: 'Голосовые каналы', hint: 'Входить и говорить в voice', group: 'Доступ', defaultCreate: true },
            { key: 'can_manage', label: 'Управление сервером', hint: 'Общие админские действия', group: 'Управление', defaultCreate: false },
            { key: 'can_manage_channels', label: 'Каналы', hint: 'Создавать и менять каналы', group: 'Управление', defaultCreate: false },
            { key: 'can_manage_roles', label: 'Роли', hint: 'Создавать и менять роли', group: 'Управление', defaultCreate: false },
            { key: 'can_invite', label: 'Приглашения', hint: 'Генерировать инвайты', group: 'Управление', defaultCreate: true },
            { key: 'can_pin', label: 'Закреплять', hint: 'Закреплять важные сообщения', group: 'Управление', defaultCreate: false },
            { key: 'can_mention', label: '@everyone', hint: 'Упоминать всех участников', group: 'Управление', defaultCreate: false },
            { key: 'can_kick', label: 'Исключать', hint: 'Кикать участников из сервера', group: 'Управление', defaultCreate: false },
            { key: 'can_ban', label: 'Бан', hint: 'Блокировать участников', group: 'Управление', defaultCreate: false },
        ];
    }

    serverRolePermissionValue(role, key) {
        if (!role) return false;
        if (Object.prototype.hasOwnProperty.call(role, key)) return !!role[key];
        const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        if (Object.prototype.hasOwnProperty.call(role, camel)) return !!role[camel];
        return false;
    }

    serverModalColorPickerState(key) {
        return !!this.S.serverModal?.colorPickers?.[key];
    }

    setServerModalColorPickerState(key, open) {
        const next = {
            ...(this.S.serverModal.colorPickers || {}),
            [key]: !!open,
        };
        this.setServerModalState({ colorPickers: next });
    }

    toggleServerModalColorPicker(key) {
        const next = !this.serverModalColorPickerState(key);
        this.setServerModalColorPickerState(key, next);
        this.renderServerModal();
    }

    serverRolePermissionsHtml(role, keyPrefix = '', attrName = 'data-role-perm') {
        const defs = this.serverRolePermissionDefs();
        const sections = defs.reduce((acc, def) => {
            if (!acc[def.group]) acc[def.group] = [];
            acc[def.group].push(def);
            return acc;
        }, {});
        return Object.entries(sections).map(([groupName, items]) => {
            const rows = items.map(def => {
                const key = def.key;
                const checked = this.serverRolePermissionValue(role, key) ? 'checked' : '';
                return `<label class="server-perm-row server-perm-row--stacked">
                    <span>
                        <strong>${this.esc(def.label)}</strong>
                        <small>${this.esc(def.hint)}</small>
                    </span>
                    <input type="checkbox" ${attrName}="${this.esc(key)}" ${checked}>
                </label>`;
            }).join('');
            return `<div class="server-perm-group">
                <div class="server-perm-group-title">${this.esc(groupName)}</div>
                <div class="server-perm-grid server-perm-grid--dense">${rows}</div>
            </div>`;
        }).join('');
    }

    serverRolePermissionsCount(role) {
        return this.serverRolePermissionDefs().reduce((total, def) => total + Number(!!this.serverRolePermissionValue(role, def.key)), 0);
    }

    serverRoleCreateDefaults() {
        const defaults = {};
        this.serverRolePermissionDefs().forEach(def => {
            defaults[def.key] = !!def.defaultCreate;
        });
        return defaults;
    }

    applyServerRoleCreateDefaults() {
        const defaults = this.serverRoleCreateDefaults();
        this.serverRolePermissionDefs().forEach(def => {
            const el = document.querySelector(`[data-server-role-perm="${CSS.escape(def.key)}"]`);
            if (el) el.checked = !!defaults[def.key];
        });
    }

    syncDraftServerRolesFromDom() {
        if (this.S.serverModal.mode !== 'create') return this.draftServerRoleList();
        const cards = Array.from(document.querySelectorAll('[data-draft-role-card]'));
        const roles = cards.map(card => {
            const draftId = String(card.getAttribute('data-draft-role-card') || '').trim();
            const permissions = {};
            this.serverRolePermissionDefs().forEach(def => {
                permissions[def.key] = !!card.querySelector(`[data-draft-role-perm="${CSS.escape(def.key)}"]`)?.checked;
            });
            return {
                draftId,
                collapsed: String(card.getAttribute('data-draft-role-collapsed') || '1') !== '0',
                name: String(card.querySelector('[data-draft-role-name]')?.value || '').trim(),
                color: this.normalizeColorValue(card.querySelector('[data-draft-role-color]')?.value || '#cbff00'),
                ...permissions,
            };
        }).filter(role => role.draftId);
        this.setServerModalState({ draftRoles: roles });
        return roles;
    }

    serverRoleOptionsHtml(selected = 'member') {
        const roles = [...this.serverRoleList(), ...this.draftServerRoleList()];
        const options = [
            { roleId: 'member', name: 'Участник' },
            { roleId: 'admin', name: 'Админ' },
            ...roles.filter(role => role.roleId && role.roleId !== 'member' && role.roleId !== 'admin' && role.roleId !== 'owner'),
        ];
        return options.map(role => {
            const roleId = String(role.roleId || '').trim();
            const label = this.esc(role.name || this.serverRoleLabel(roleId));
            const isSelected = roleId === String(selected || '').trim() ? 'selected' : '';
            return `<option value="${this.esc(roleId)}" ${isSelected}>${label}</option>`;
        }).join('');
    }

    normalizeColorValue(value) {
        const raw = String(value || '').trim();
        if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
        return '#cbff00';
    }

    hexToRgb(hex) {
        const value = this.normalizeColorValue(hex).slice(1);
        const num = Number.parseInt(value, 16);
        return {
            r: (num >> 16) & 255,
            g: (num >> 8) & 255,
            b: num & 255,
        };
    }

    rgbToHex(r, g, b) {
        const toHex = (n) => Number(n || 0).toString(16).padStart(2, '0');
        return `#${toHex(Math.max(0, Math.min(255, Math.round(r))))}${toHex(Math.max(0, Math.min(255, Math.round(g))))}${toHex(Math.max(0, Math.min(255, Math.round(b))))}`;
    }

    rgbToHsl(r, g, b) {
        const rn = (r || 0) / 255;
        const gn = (g || 0) / 255;
        const bn = (b || 0) / 255;
        const max = Math.max(rn, gn, bn);
        const min = Math.min(rn, gn, bn);
        const delta = max - min;
        let h = 0;
        let s = 0;
        const l = (max + min) / 2;
        if (delta !== 0) {
            s = delta / (1 - Math.abs(2 * l - 1));
            switch (max) {
                case rn:
                    h = 60 * (((gn - bn) / delta) % 6);
                    break;
                case gn:
                    h = 60 * (((bn - rn) / delta) + 2);
                    break;
                default:
                    h = 60 * (((rn - gn) / delta) + 4);
                    break;
            }
        }
        return {
            h: (h + 360) % 360,
            s: s * 100,
            l: l * 100,
        };
    }

    hslToRgb(h, s, l) {
        const hue = ((h % 360) + 360) % 360;
        const sat = Math.max(0, Math.min(100, Number(s) || 0)) / 100;
        const lig = Math.max(0, Math.min(100, Number(l) || 0)) / 100;
        const c = (1 - Math.abs(2 * lig - 1)) * sat;
        const hp = hue / 60;
        const x = c * (1 - Math.abs((hp % 2) - 1));
        let r1 = 0, g1 = 0, b1 = 0;
        if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
        else if (hp < 2) [r1, g1, b1] = [x, c, 0];
        else if (hp < 3) [r1, g1, b1] = [0, c, x];
        else if (hp < 4) [r1, g1, b1] = [0, x, c];
        else if (hp < 5) [r1, g1, b1] = [x, 0, c];
        else [r1, g1, b1] = [c, 0, x];
        const m = lig - c / 2;
        return {
            r: Math.round((r1 + m) * 255),
            g: Math.round((g1 + m) * 255),
            b: Math.round((b1 + m) * 255),
        };
    }

    hueToHex(hue) {
        const rgb = this.hslToRgb(hue, 100, 50);
        return this.rgbToHex(rgb.r, rgb.g, rgb.b);
    }

    bindColorWheel({ wheelId, hiddenId, hexId, initialValue = '#cbff00' }) {
        const wheel = document.getElementById(wheelId);
        const hidden = document.getElementById(hiddenId);
        const hexInput = document.getElementById(hexId);
        if (!wheel || this.colorWheelBindings.has(wheelId)) return;
        this.colorWheelBindings.add(wheelId);
        const updatePreview = (value) => {
            const normalized = this.normalizeColorValue(value);
            const picker = wheel.closest('.color-picker');
            const preview = picker?.querySelector('.color-picker-preview');
            if (preview) preview.style.background = normalized;
        };

        const setFromPoint = (clientX, clientY) => {
            const rect = wheel.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            const dx = clientX - rect.left - rect.width / 2;
            const dy = clientY - rect.top - rect.height / 2;
            const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
            const nextValue = this.hueToHex(angle);
            this.applyColorWheelValue({ wheel, hidden, hexInput, value: nextValue });
            updatePreview(nextValue);
        };

        const onPointerDown = (e) => {
            e.preventDefault();
            try { wheel.setPointerCapture(e.pointerId); } catch (_) {}
            setFromPoint(e.clientX, e.clientY);
        };
        const onPointerMove = (e) => {
            if ((e.buttons || 0) === 0) return;
            setFromPoint(e.clientX, e.clientY);
        };
        const onClick = (e) => {
            if (typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return;
            setFromPoint(e.clientX, e.clientY);
        };
        const onHexInput = () => {
            const nextValue = hexInput?.value || hidden?.value || initialValue;
            this.applyColorWheelValue({ wheel, hidden, hexInput, value: nextValue });
            updatePreview(nextValue);
        };

        wheel.addEventListener('pointerdown', onPointerDown);
        wheel.addEventListener('pointermove', onPointerMove);
        wheel.addEventListener('mousedown', onPointerDown);
        wheel.addEventListener('click', onClick);
        hexInput?.addEventListener('input', onHexInput);
        hidden?.addEventListener('input', () => {
            this.applyColorWheelValue({ wheel, hidden, hexInput, value: hidden.value });
            updatePreview(hidden.value);
        });
    }

    applyColorWheelValue({ wheel, hidden, hexInput, value }) {
        if (!wheel) return;
        const normalized = this.normalizeColorValue(value);
        const { h } = this.rgbToHsl(...Object.values(this.hexToRgb(normalized)));
        const rect = wheel.getBoundingClientRect();
        const radius = Math.max(20, Math.min(rect.width, rect.height) * 0.36);
        const angle = ((h - 90) * Math.PI) / 180;
        const x = (rect.width / 2) + Math.cos(angle) * radius;
        const y = (rect.height / 2) + Math.sin(angle) * radius;
        wheel.style.setProperty('--thumb-x', `${x}px`);
        wheel.style.setProperty('--thumb-y', `${y}px`);
        wheel.style.setProperty('--wheel-color', normalized);
        if (hidden && hidden.value !== normalized) hidden.value = normalized;
        if (hexInput && hexInput.value.toLowerCase() !== normalized) hexInput.value = normalized;
    }

    canManageServer(server = null) {
        const current = server || this.currentServer();
        const role = this.normalizeMemberRole(current?.myRole || current?.my_role || '');
        return role === 'owner' || role === 'admin';
    }

    openServerOverlay() {
        const overlay = document.getElementById('serverOverlay');
        if (overlay) {
            overlay.hidden = false;
            requestAnimationFrame(() => overlay.classList.add('visible'));
        }
    }

    closeServerOverlay() {
        const overlay = document.getElementById('serverOverlay');
        if (overlay) {
            overlay.classList.remove('visible');
            setTimeout(() => {
                overlay.hidden = true;
            }, 180);
        }
    }

    setServerModalState(partial = {}) {
        this.S.serverModal = {
            ...this.S.serverModal,
            ...partial,
        };
    }

    serverModalSectionsForMode(mode = this.S.serverModal.mode) {
        if (mode === 'discover') return ['discover'];
        if (mode === 'edit') return ['overview', 'channels', 'roles', 'members'];
        return ['overview', 'channels', 'roles', 'members'];
    }

    serverModalDefaultSection(mode = this.S.serverModal.mode) {
        return mode === 'discover' ? 'discover' : 'overview';
    }

    serverModalActiveSection(mode = this.S.serverModal.mode) {
        const allowed = this.serverModalSectionsForMode(mode);
        const current = String(this.S.serverModal.activeSection || '').trim() || this.serverModalDefaultSection(mode);
        return allowed.includes(current) ? current : this.serverModalDefaultSection(mode);
    }

    setServerModalSection(section) {
        const next = String(section || '').trim();
        if (!next) return;
        const allowed = this.serverModalSectionsForMode();
        if (!allowed.includes(next)) return;
        if (this.S.serverModal.activeSection === next) return;
        this.setServerModalState({ activeSection: next });
        this.renderServerModal();
    }

    renderServerModalMembers() {
        const list = document.getElementById('serverMembersList');
        const count = document.getElementById('serverMembersCount');
        const server = this.currentServer();
        const members = Array.isArray(this.S.serverModal.members) ? this.S.serverModal.members : [];
        const canManage = this.canManageServer(server);
        if (count) count.textContent = String(members.length || 0);
        if (!list) return;
        if (this.S.serverModal.loading && members.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Загрузка участников</div>
                <div class="empty-sub">Подождите секунду</div>
            </div>`;
            return;
        }
        if (this.S.serverModal.mode !== 'edit') {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">После создания</div>
                <div class="empty-sub">Здесь появятся участники и роли</div>
            </div>`;
            return;
        }

        if (members.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Нет участников</div>
                <div class="empty-sub">Добавьте первых участников сервера</div>
            </div>`;
            return;
        }

        list.innerHTML = members.map(member => {
            const role = this.normalizeMemberRole(member.role);
            const isOwner = role === 'owner';
            const joined = member.joinedAt ? this.fmtDate(member.joinedAt) || this.fmtTime(member.joinedAt) : '';
            const select = `
                <select class="settings-input server-member-role" data-member-role="${this.esc(member.username)}" ${isOwner ? 'disabled' : ''}>
                    ${isOwner ? '<option value="owner" selected>Владелец</option>' : this.serverRoleOptionsHtml(role)}
                </select>
            `;
            return `<div class="server-member-row ${isOwner ? 'owner' : ''}">
                <div class="server-member-info">
                    <div class="server-member-name">${this.esc(member.username)}</div>
                    <div class="server-member-meta">${this.esc(this.serverRoleLabel(role))}${joined ? ` · ${this.esc(joined)}` : ''}</div>
                </div>
                ${select}
                <button class="server-member-remove" type="button" data-member-remove="${this.esc(member.username)}" ${isOwner || !canManage ? 'disabled' : ''} title="Удалить">×</button>
            </div>`;
        }).join('');
    }

    renderPublicServersModal() {
        const list = document.getElementById('serverDiscoverList');
        const count = document.getElementById('serverDiscoverCount');
        const refreshBtn = document.getElementById('serverDiscoverRefreshBtn');
        const servers = this.renderFilteredPublicServers();
        if (count) count.textContent = String(servers.length || 0);
        if (refreshBtn) refreshBtn.disabled = !!this.S.serverModal.loading;
        if (!list) return;
        if (this.S.serverModal.loading && servers.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Поиск серверов</div>
                <div class="empty-sub">Секунду, подбираем публичные сообщества</div>
            </div>`;
            return;
        }
        if (servers.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Публичных серверов нет</div>
                <div class="empty-sub">Пока что нечего открывать из меню</div>
            </div>`;
            return;
        }

        list.innerHTML = servers.map(server => {
            const memberCount = Number(server.memberCount || server.member_count || 0) || 0;
            const channelCount = Array.isArray(server.channels) ? server.channels.length : 0;
            const role = this.normalizeMemberRole(server.myRole || server.my_role || '');
            const alreadyJoined = role === 'owner' || role === 'admin' || role === 'member';
            const joinTarget = server.joinLink || server.join_link || server.id;
            const actionLabel = alreadyJoined ? 'Открыть' : 'Войти';
            return `<div class="server-discover-row">
                <button class="server-item server-discover-item" type="button" data-public-server-id="${this.esc(server.id)}" title="${this.esc(server.name)}">
                    <span class="server-avatar" style="background:${this.safeCssColor(server.color) || 'linear-gradient(180deg, #cbff00, #8c8c8c)'}">${this.esc(server.icon || server.name?.[0] || 'S')}</span>
                    <div class="server-meta">
                        <div class="server-name">${this.esc(server.name)}</div>
                        <div class="server-prev">${this.esc(server.description || 'Публичный сервер')}${channelCount ? ` · ${channelCount} каналов` : ''}${memberCount ? ` · ${memberCount} участников` : ''}</div>
                    </div>
                </button>
                <div class="server-discover-actions">
                    <button class="btn-flat" type="button" data-public-server-open="${this.esc(server.id)}">${actionLabel}</button>
                    <button class="btn-flat" type="button" data-public-server-join="${this.esc(joinTarget)}">${alreadyJoined ? 'Перейти' : 'Вступить'}</button>
                </div>
            </div>`;
        }).join('');
    }

    renderServerModal() {
        const server = this.currentServer();
        const mode = this.S.serverModal.mode;
        const isEdit = mode === 'edit';
        const isDiscover = mode === 'discover';
        const activeSection = this.serverModalActiveSection(mode);
        const createDraft = !isEdit && !isDiscover ? this.syncServerCreateDraftFromDom() : null;
        const createDraftView = !isEdit && !isDiscover ? (createDraft || this.serverCreateDraft()) : null;
        const grid = document.querySelector('.server-modal-grid');
        const nav = document.getElementById('serverModalNav');
        const sidebarTitle = document.getElementById('serverModalSidebarTitle');
        const sidebarHint = document.getElementById('serverModalSidebarHint');
        const basicsCard = document.getElementById('serverBasicsCard');
        const channelsCard = document.getElementById('serverChannelsCard');
        const membersCard = document.getElementById('serverMembersCard');
        const discoverCard = document.getElementById('serverDiscoverCard');
        const overviewPanel = document.getElementById('serverOverviewPanel');
        const channelsPanel = document.getElementById('serverChannelsPanel');
        const rolesPanel = document.getElementById('serverRolesPanel');
        const membersPanel = document.getElementById('serverMembersPanel');
        const discoverPanel = document.getElementById('serverDiscoverPanel');
        const title = document.getElementById('serverModalTitle');
        const hint = document.getElementById('serverModalHint');
        const kicker = document.getElementById('serverModalKicker');
        const modeNote = document.getElementById('serverModalModeNote');
        const saveBtn = document.getElementById('serverSaveBtn');
        const deleteBtn = document.getElementById('serverDeleteBtn');
        const serverModalCancel = document.getElementById('serverModalCancel');
        const nameInput = document.getElementById('serverNameInput');
        const descInput = document.getElementById('serverDescriptionInput');
        const iconInput = document.getElementById('serverIconInput');
        const colorInput = document.getElementById('serverColorInput');
        const publicInput = document.getElementById('serverPublicInput');
        const serverMembersList = document.getElementById('serverMembersList');
        const serverRolesCard = document.getElementById('serverRolesCard');
        const serverJoinLinkInput = document.getElementById('serverJoinLinkInput');
        const serverJoinLinkGenerateBtn = document.getElementById('serverJoinLinkGenerateBtn');
        const serverJoinLinkCopyBtn = document.getElementById('serverJoinLinkCopyBtn');
        const serverChannelCreate = document.querySelector('[data-server-channel-create]');
        const serverChannelCreateBody = document.querySelector('[data-server-channel-create-body]');
        const serverChannelCreateToggleBtn = document.getElementById('serverChannelCreateBtn');
        const serverChannelCreateSubmitBtn = document.getElementById('serverChannelCreateSubmitBtn');
        const serverChannelNameInput = document.getElementById('serverChannelNameInput');
        const serverChannelTopicInput = document.getElementById('serverChannelTopicInput');
        const serverChannelKindInput = document.getElementById('serverChannelKindInput');
        const serverAvatarUploadBtn = document.getElementById('serverAvatarUploadBtn');
        const serverAvatarRemoveBtn = document.getElementById('serverAvatarRemoveBtn');
        const serverBannerUploadBtn = document.getElementById('serverBannerUploadBtn');
        const serverBannerRemoveBtn = document.getElementById('serverBannerRemoveBtn');
        const serverRoleNameInput = document.getElementById('serverRoleNameInput');
        const serverRoleColorInput = document.getElementById('serverRoleColorInput');
        const serverRolePermView = document.getElementById('serverRolePermView');
        const serverRolePermSend = document.getElementById('serverRolePermSend');
        const serverRolePermManage = document.getElementById('serverRolePermManage');
        const serverRoleCreate = document.querySelector('[data-server-role-create]');
        const serverRoleCreateBody = document.querySelector('[data-server-role-create-body]');
        const serverRoleCreateToggleBtn = document.getElementById('serverRoleCreateBtn');
        const serverRoleCreateSubmitBtn = document.getElementById('serverRoleCreateSubmitBtn');
        const discoverQuery = document.getElementById('serverDiscoverQuery');
        const errorBox = document.getElementById('serverModalError');
        const canManage = this.canManageServer(server);
        const current = isEdit && this.S.serverModal.serverId
            ? (this.S.servers || []).find(s => s.id === this.S.serverModal.serverId)
            : null;

        this.S.serverModal.activeSection = activeSection;

        if (grid) grid.classList.toggle('is-discover', isDiscover);
        if (basicsCard) basicsCard.hidden = activeSection !== 'overview';
        if (channelsCard) channelsCard.hidden = activeSection !== 'channels';
        if (membersCard) membersCard.hidden = activeSection !== 'members';
        if (serverRolesCard) serverRolesCard.hidden = activeSection !== 'roles';
        if (discoverCard) discoverCard.hidden = activeSection !== 'discover';
        if (overviewPanel) overviewPanel.hidden = activeSection !== 'overview';
        if (channelsPanel) channelsPanel.hidden = activeSection !== 'channels';
        if (rolesPanel) rolesPanel.hidden = activeSection !== 'roles';
        if (membersPanel) membersPanel.hidden = activeSection !== 'members';
        if (discoverPanel) discoverPanel.hidden = activeSection !== 'discover';
        if (nav) {
            nav.querySelectorAll('[data-server-modal-section]').forEach(btn => {
                const section = btn.getAttribute('data-server-modal-section');
                const visible = isDiscover ? section === 'discover' : section !== 'discover';
                btn.hidden = !visible;
                btn.classList.toggle('active', visible && section === activeSection);
            });
        }
        if (sidebarTitle) sidebarTitle.textContent = isEdit ? (current?.name || server?.name || 'Настройки сервера') : isDiscover ? 'Поиск серверов' : 'Создание сервера';
        if (sidebarHint) sidebarHint.textContent = isEdit
            ? (activeSection === 'overview'
                ? 'Основные параметры сервера и внешний вид.'
                : activeSection === 'channels'
                    ? 'Создавайте, редактируйте и удаляйте каналы.'
                    : activeSection === 'roles'
                        ? 'Настройка ролей и прав доступа.'
                        : 'Управление участниками и их ролями.')
            : isDiscover
                ? 'Подберите сервер и войдите в него из каталога.'
                : activeSection === 'roles'
                    ? 'Соберите роли до создания сервера.'
                    : 'Имя, оформление и базовая конфигурация.';
        if (title) title.textContent = isEdit ? 'Настройки сервера' : isDiscover ? 'Публичные серверы' : 'Создать сервер';
        if (hint) hint.textContent = isEdit
            ? (activeSection === 'overview'
                ? 'Переименуйте сервер, измените оформление и ссылку входа.'
                : activeSection === 'channels'
                    ? 'Управляйте каналами сервера.'
                : activeSection === 'roles'
                    ? 'Управляйте ролями и правами доступа.'
                    : 'Добавляйте участников и назначайте им роли.')
            : isDiscover
                ? 'Выберите публичный сервер и войдите в него через меню без автодобавления в список.'
            : activeSection === 'roles'
                ? 'Настройте роли и доступ перед созданием.'
                : 'Настройте имя, оформление и доступ перед созданием.';
        if (kicker) kicker.textContent = isEdit ? 'Settings' : isDiscover ? 'Discover' : 'Creation';
        if (modeNote) modeNote.textContent = isEdit ? 'edit' : isDiscover ? 'browse' : 'create';
        if (saveBtn) {
            saveBtn.hidden = isDiscover;
            saveBtn.textContent = this.S.serverModal.saving ? 'Сохранение...' : (isEdit ? 'Сохранить' : 'Создать');
            saveBtn.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        }
        if (deleteBtn) deleteBtn.hidden = !isEdit || !canManage || this.normalizeMemberRole(current?.myRole || current?.my_role || '') !== 'owner';
        if (serverModalCancel) serverModalCancel.textContent = isDiscover ? 'Закрыть' : 'Отмена';
        if (nameInput) nameInput.value = isEdit ? (current?.name || '') : (createDraftView?.name || '');
        if (descInput) descInput.value = isEdit ? (current?.description || '') : (createDraftView?.description || '');
        if (iconInput) iconInput.value = isEdit ? (current?.icon || '') : (createDraftView?.icon || '');
        const normalizedColor = this.normalizeColorValue(isEdit ? (current?.color || '#cbff00') : (createDraftView?.color || '#cbff00'));
        if (colorInput) colorInput.value = normalizedColor;
        const colorHexInput = document.getElementById('serverColorHexInput');
        if (colorHexInput) colorHexInput.value = normalizedColor;
        const serverColorPickerPreview = document.querySelector('[data-color-picker-key="server-basics"] .color-picker-preview');
        if (serverColorPickerPreview) serverColorPickerPreview.style.background = normalizedColor;
        this.applyColorWheelValue({
            wheel: document.getElementById('serverColorWheel'),
            hidden: colorInput,
            hexInput: colorHexInput,
            value: normalizedColor,
        });
        if (publicInput) publicInput.checked = isEdit ? !!current?.is_public : !!(createDraftView?.isPublic ?? true);
        if (discoverQuery && !discoverQuery.value) {
            discoverQuery.value = '';
        }
        const editLocked = !isEdit;
        const linkLocked = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        if (serverAvatarUploadBtn) serverAvatarUploadBtn.disabled = editLocked;
        if (serverAvatarRemoveBtn) serverAvatarRemoveBtn.disabled = editLocked;
        if (serverBannerUploadBtn) serverBannerUploadBtn.disabled = editLocked;
        if (serverBannerRemoveBtn) serverBannerRemoveBtn.disabled = editLocked;
        if (serverJoinLinkInput) serverJoinLinkInput.disabled = linkLocked;
        if (serverJoinLinkGenerateBtn) serverJoinLinkGenerateBtn.disabled = linkLocked;
        if (serverJoinLinkCopyBtn) serverJoinLinkCopyBtn.disabled = linkLocked;
        if (serverRoleNameInput) serverRoleNameInput.disabled = false;
        if (serverRoleColorInput) serverRoleColorInput.disabled = false;
        const serverRoleColorHexInput = document.getElementById('serverRoleColorHexInput');
        if (serverRoleColorHexInput) serverRoleColorHexInput.disabled = false;
        if (serverRolePermView) serverRolePermView.disabled = false;
        if (serverRolePermSend) serverRolePermSend.disabled = false;
        if (serverRolePermManage) serverRolePermManage.disabled = false;
        const roleCreateOpen = !!this.S.serverModal.roleCreateOpen;
        if (serverRoleCreate) serverRoleCreate.classList.toggle('is-collapsed', !roleCreateOpen);
        if (serverRoleCreateBody) serverRoleCreateBody.hidden = !roleCreateOpen;
        if (serverRoleCreateToggleBtn) serverRoleCreateToggleBtn.textContent = roleCreateOpen ? 'Свернуть' : 'Новая роль';
        if (serverRoleCreateSubmitBtn) serverRoleCreateSubmitBtn.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading || !roleCreateOpen;
        if (serverAvatarUploadBtn) serverAvatarUploadBtn.title = isEdit ? 'Загрузить аватар' : 'Создать сервер сначала';
        if (serverAvatarRemoveBtn) serverAvatarRemoveBtn.title = isEdit ? 'Удалить аватар' : 'Создать сервер сначала';
        if (serverBannerUploadBtn) serverBannerUploadBtn.title = isEdit ? 'Загрузить баннер' : 'Создать сервер сначала';
        if (serverBannerRemoveBtn) serverBannerRemoveBtn.title = isEdit ? 'Удалить баннер' : 'Создать сервер сначала';
        if (errorBox) errorBox.textContent = this.S.serverModal.error || '';
        if (serverMembersList) {
            serverMembersList.classList.toggle('is-loading', !!this.S.serverModal.loading);
        }
        const roleSelect = document.getElementById('serverMemberRole');
        if (roleSelect) {
            roleSelect.innerHTML = this.serverRoleOptionsHtml(roleSelect.value || 'member');
        }
        if (serverRoleColorInput) {
            const roleColor = this.normalizeColorValue(serverRoleColorInput.value || '#cbff00');
            serverRoleColorInput.value = roleColor;
            if (serverRoleColorHexInput) serverRoleColorHexInput.value = roleColor;
            const createPicker = document.querySelector('[data-color-picker-key="server-role-create"]');
            const createPickerOpen = this.serverModalColorPickerState('server-role-create');
            const createPickerPreview = createPicker?.querySelector('.color-picker-preview');
            if (createPickerPreview) createPickerPreview.style.background = roleColor;
            if (createPicker) createPicker.classList.toggle('is-collapsed', !createPickerOpen);
            const createPickerToggle = createPicker?.querySelector('[data-color-picker-toggle="server-role-create"]');
            if (createPickerToggle) createPickerToggle.textContent = createPickerOpen ? 'Свернуть' : 'Развернуть';
            if (activeSection === 'roles') {
                this.applyColorWheelValue({
                    wheel: document.getElementById('serverRoleColorWheel'),
                    hidden: serverRoleColorInput,
                    hexInput: serverRoleColorHexInput,
                    value: roleColor,
                });
            }
        }
        const channelCreateOpen = !!this.S.serverModal.channelCreateOpen;
        if (serverChannelCreate) serverChannelCreate.classList.toggle('is-collapsed', !channelCreateOpen);
        if (serverChannelCreateBody) serverChannelCreateBody.hidden = !channelCreateOpen;
        if (serverChannelCreateToggleBtn) serverChannelCreateToggleBtn.textContent = channelCreateOpen ? 'Свернуть' : 'Новый канал';
        if (serverChannelCreateSubmitBtn) serverChannelCreateSubmitBtn.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading || !channelCreateOpen;
        if (serverChannelNameInput) serverChannelNameInput.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        if (serverChannelTopicInput) serverChannelTopicInput.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        if (serverChannelKindInput) serverChannelKindInput.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        const serverColorPicker = document.querySelector('[data-color-picker-key="server-basics"]');
        if (serverColorPicker) {
            const open = this.serverModalColorPickerState('server-basics');
            serverColorPicker.classList.toggle('is-collapsed', !open);
            const toggle = serverColorPicker.querySelector('[data-color-picker-toggle="server-basics"]');
            if (toggle) toggle.textContent = open ? 'Свернуть' : 'Развернуть';
        }
        if (activeSection === 'overview') {
            this.renderServerJoinLink();
        } else if (activeSection === 'channels') {
            this.renderServerChannels();
        } else if (activeSection === 'roles') {
            this.renderServerRoles();
        } else if (activeSection === 'members') {
            this.renderServerModalMembers();
        } else if (activeSection === 'discover') {
            this.renderPublicServersModal();
        }
        if (isEdit && (this.S.serverModal.serverId || server?.id)) {
            this.syncServerAssetPreview(this.S.serverModal.serverId || server?.id || '');
        } else {
            this.resetServerAssetPreview();
        }
    }

    async loadServerMembers(serverId) {
        const sid = String(serverId || '').trim();
        if (!sid) return [];
        const res = await this.apiFetch(this.apiRoutes.servers.members(sid));
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось загрузить участников сервера');
        }
        const data = await res.json();
        const members = Array.isArray(data) ? data : (Array.isArray(data?.members) ? data.members : []);
        return members.map(member => ({
            ...member,
            role: this.normalizeMemberRole(member.role),
        }));
    }

    async loadServerRoles(serverId) {
        const sid = String(serverId || '').trim();
        if (!sid) return [];
        const res = await this.apiFetch(this.apiRoutes.servers.roles(sid));
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось загрузить роли сервера');
        }
        const data = await res.json();
        const roles = Array.isArray(data?.roles) ? data.roles : [];
        return roles.map(role => ({
            ...role,
            roleId: String(role.roleId || role.role_id || '').trim(),
            name: String(role.name || '').trim(),
            color: String(role.color || '#cbff00').trim(),
            canView: !!(role.canView ?? role.can_view),
            canSend: !!(role.canSend ?? role.can_send),
            canManage: !!(role.canManage ?? role.can_manage),
            canManageChannels: !!(role.canManageChannels ?? role.can_manage_channels),
            canManageRoles: !!(role.canManageRoles ?? role.can_manage_roles),
            canInvite: !!(role.canInvite ?? role.can_invite),
            canAttach: !!(role.canAttach ?? role.can_attach),
            canEmbed: !!(role.canEmbed ?? role.can_embed),
            canReact: !!(role.canReact ?? role.can_react),
            canPin: !!(role.canPin ?? role.can_pin),
            canMention: !!(role.canMention ?? role.can_mention),
            canVoice: !!(role.canVoice ?? role.can_voice),
            canKick: !!(role.canKick ?? role.can_kick),
            canBan: !!(role.canBan ?? role.can_ban),
            position: Number(role.position || 0) || 0,
        }));
    }

    async loadServerChannels(serverId) {
        const sid = String(serverId || '').trim();
        if (!sid) return [];
        const res = await this.apiFetch(this.apiRoutes.servers.channels(sid));
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось загрузить каналы сервера');
        }
        const data = await res.json();
        const channels = Array.isArray(data) ? data : (Array.isArray(data?.channels) ? data.channels : []);
        return this.normalizeServerChannels(channels);
    }

    normalizeServerChannels(channels) {
        return (Array.isArray(channels) ? channels : [])
            .filter(Boolean)
            .map((channel, index) => ({
                ...channel,
                id: String(channel.id || '').trim(),
                name: String(channel.name || '').trim(),
                topic: String(channel.topic || '').trim(),
                kind: this.normalizeChannelKind(channel.kind),
                position: Number.isFinite(Number(channel.position)) ? Number(channel.position) : index,
            }))
            .sort((a, b) => Number(a.position || 0) - Number(b.position || 0) || String(a.name || '').localeCompare(String(b.name || '')));
    }

    normalizeChannelKind(kind) {
        return String(kind || 'text').trim().toLowerCase() === 'voice' ? 'voice' : 'text';
    }

    channelKindLabel(kind) {
        return this.normalizeChannelKind(kind) === 'voice' ? 'Голосовой' : 'Текстовый';
    }

    renderServerJoinLink() {
        const input = document.getElementById('serverJoinLinkInput');
        if (!input) return;
        const link = this.S.serverModal.mode === 'create'
            ? (this.serverCreateDraft()?.joinLink || this.S.serverModal.joinLink || '')
            : (this.S.serverModal.joinLink || '');
        input.value = link;
    }

    serverCreateDraftDefaults() {
        return {
            name: '',
            description: '',
            icon: '',
            color: '#cbff00',
            joinLink: '',
            isPublic: true,
        };
    }

    serverCreateDraft() {
        return {
            ...this.serverCreateDraftDefaults(),
            ...(this.S.serverModal.createDraft || {}),
        };
    }

    syncServerCreateDraftFromDom() {
        if (this.S.serverModal.mode !== 'create') {
            return this.serverCreateDraft();
        }
        const current = this.serverCreateDraft();
        const nameInput = document.getElementById('serverNameInput');
        const descInput = document.getElementById('serverDescriptionInput');
        const iconInput = document.getElementById('serverIconInput');
        const colorInput = document.getElementById('serverColorInput');
        const joinLinkInput = document.getElementById('serverJoinLinkInput');
        const publicInput = document.getElementById('serverPublicInput');
        const next = {
            ...current,
            name: String(nameInput?.value ?? current.name ?? ''),
            description: String(descInput?.value ?? current.description ?? ''),
            icon: String(iconInput?.value ?? current.icon ?? ''),
            color: this.normalizeColorValue(colorInput?.value || current.color || '#cbff00'),
            joinLink: String(joinLinkInput?.value ?? current.joinLink ?? ''),
            isPublic: publicInput ? !!publicInput.checked : !!current.isPublic,
        };
        this.setServerModalState({
            createDraft: next,
            joinLink: next.joinLink,
        });
        return next;
    }

    renderServerRoles() {
        const list = document.getElementById('serverRolesList');
        const count = document.getElementById('serverRolesCount');
        const isEdit = this.S.serverModal.mode === 'edit';
        const roles = isEdit ? this.serverRoleList() : this.draftServerRoleList();
        if (count) count.textContent = String(roles.length || 0);
        if (!list) return;
        if (roles.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">${isEdit ? 'Ролей нет' : 'Черновики ролей'}</div>
                <div class="empty-sub">${isEdit ? 'Создайте первую роль' : 'Добавьте роли перед созданием сервера'}</div>
            </div>`;
            return;
        }
        const renderColorPicker = ({ pickerKey, wheelId, colorId, hexId, currentColor, isRoleCard = false }) => {
            const open = this.serverModalColorPickerState(pickerKey);
            return `<div class="color-picker color-picker--compact color-picker--collapsible ${open ? '' : 'is-collapsed'}" data-color-picker-key="${this.esc(pickerKey)}">
                <div class="color-picker-head">
                    <div class="color-picker-summary">
                        <span class="color-picker-preview" style="background:${this.safeCssColor(currentColor) || 'transparent'}"></span>
                        <div class="color-picker-copy">
                            <div class="color-picker-title">RGB</div>
                            <div class="color-picker-sub">${open ? 'Колесо открыто' : 'Свернуто по умолчанию'}</div>
                        </div>
                    </div>
                    <button class="btn-flat color-picker-toggle" type="button" data-color-picker-toggle="${this.esc(pickerKey)}">${open ? 'Свернуть' : 'Развернуть'}</button>
                </div>
                <div class="color-picker-body">
                    <div class="color-wheel ${isRoleCard ? 'color-wheel--tiny' : 'color-wheel--small'}" id="${this.esc(wheelId)}" tabindex="0" aria-label="Цвет роли">
                        <div class="color-wheel-thumb"></div>
                        <div class="color-wheel-center">${isRoleCard ? '' : 'RGB'}</div>
                    </div>
                    <div class="color-picker-side">
                        <input type="hidden" ${isRoleCard ? `data-role-color="${this.esc(pickerKey)}"` : `data-draft-role-color="${this.esc(pickerKey)}"`} id="${this.esc(colorId)}" value="${this.esc(currentColor)}">
                        <input class="settings-input color-hex-input" type="text" id="${this.esc(hexId)}" maxlength="7" value="${this.esc(currentColor)}" aria-label="HEX цвет роли">
                    </div>
                </div>
            </div>`;
        };
        list.innerHTML = roles.map(role => {
            if (!isEdit) {
                const draftId = String(role.draftId || '').trim();
                const safeDraftId = draftId.replace(/[^a-z0-9_-]/gi, '_');
                const wheelId = `draftRoleColorWheel-${safeDraftId}`;
                const colorId = `draftRoleColorInput-${safeDraftId}`;
                const hexId = `draftRoleColorHexInput-${safeDraftId}`;
                const currentColor = this.normalizeColorValue(role.color || '#cbff00');
                const collapsed = role.collapsed !== false;
                const draftPermCount = this.serverRolePermissionsCount(role);
                return `<div class="server-role-card draft-role ${collapsed ? 'collapsed' : ''}" data-draft-role-card="${this.esc(draftId)}" data-draft-role-collapsed="${collapsed ? '1' : '0'}">
                    <div class="server-role-head server-role-head--draft">
                        <span class="server-role-chip" style="background:${this.safeCssColor(currentColor) || 'transparent'}"></span>
                        <div>
                            <div class="server-role-name">${this.esc(role.name || 'Новая роль')}</div>
                            <div class="server-role-meta">черновик</div>
                        </div>
                        <button class="btn-flat server-role-toggle" type="button" data-draft-role-toggle="${this.esc(draftId)}">${collapsed ? 'Развернуть' : 'Свернуть'}</button>
                    </div>
                    <div class="server-role-body">
                        <div class="server-role-meta server-role-summary">Права: ${draftPermCount}/${this.serverRolePermissionDefs().length}</div>
                        <div class="server-role-controls">
                        <input class="settings-input" data-draft-role-name="${this.esc(draftId)}" value="${this.esc(role.name || '')}" placeholder="Название роли">
                        ${renderColorPicker({ pickerKey: draftId, wheelId, colorId, hexId, currentColor, isRoleCard: false })}
                        ${this.serverRolePermissionsHtml(role, draftId, 'data-draft-role-perm')}
                        <div class="server-role-actions">
                            <button class="btn-flat" type="button" data-draft-role-delete="${this.esc(draftId)}">Удалить</button>
                        </div>
                        </div>
                    </div>
                </div>`;
            }
            const locked = role.roleId === 'member' || role.roleId === 'admin';
            const safeRoleId = String(role.roleId || '').replace(/[^a-z0-9_-]/gi, '_');
            const wheelId = `roleColorWheel-${safeRoleId}`;
            const colorId = `roleColorInput-${safeRoleId}`;
            const hexId = `roleColorHexInput-${safeRoleId}`;
            const currentColor = this.normalizeColorValue(role.color || '#cbff00');
            const rolePermCount = this.serverRolePermissionsCount(role);
            const colorPickerKey = role.roleId || safeRoleId;
            const options = `
                <div class="server-role-controls">
                    <input class="settings-input" data-role-name="${this.esc(role.roleId)}" value="${this.esc(role.name || '')}">
                    ${renderColorPicker({ pickerKey: colorPickerKey, wheelId, colorId, hexId, currentColor, isRoleCard: true })}
                    <div class="server-role-actions">
                        <button class="btn-flat" type="button" data-role-save="${this.esc(role.roleId)}">Сохранить</button>
                        <button class="btn-flat" type="button" data-role-delete="${this.esc(role.roleId)}" ${locked ? 'disabled' : ''}>Удалить</button>
                    </div>
                </div>
            `;
            return `<div class="server-role-card ${locked ? 'owner-role' : ''}" data-role-card="${this.esc(role.roleId)}">
                <div class="server-role-head">
                    <span class="server-role-chip" style="background:${this.safeCssColor(role.color) || '#cbff00'}"></span>
                    <div>
                        <div class="server-role-name">${this.esc(role.name || role.roleId)}</div>
                        <div class="server-role-meta">${this.esc(role.roleId)}</div>
                    </div>
                    <span class="server-role-meta">${locked ? 'системная' : 'роль'}</span>
                </div>
                <div class="server-role-meta server-role-summary">Права: ${rolePermCount}/${this.serverRolePermissionDefs().length}</div>
                ${this.serverRolePermissionsHtml(role, role.roleId, 'data-role-perm')}
                ${options}
            </div>`;
        }).join('');
        requestAnimationFrame(() => {
            roles.forEach(role => {
                if (!isEdit) {
                    const draftId = String(role.draftId || '').trim();
                const safeDraftId = draftId.replace(/[^a-z0-9_-]/gi, '_');
                this.colorWheelBindings.delete(`draftRoleColorWheel-${safeDraftId}`);
                this.bindColorWheel({
                    wheelId: `draftRoleColorWheel-${safeDraftId}`,
                    hiddenId: `draftRoleColorInput-${safeDraftId}`,
                    hexId: `draftRoleColorHexInput-${safeDraftId}`,
                    initialValue: this.normalizeColorValue(role.color || '#cbff00'),
                });
                return;
            }
            const safeRoleId = String(role.roleId || '').replace(/[^a-z0-9_-]/gi, '_');
            const wheelId = `roleColorWheel-${safeRoleId}`;
            const colorId = `roleColorInput-${safeRoleId}`;
            const hexId = `roleColorHexInput-${safeRoleId}`;
            this.colorWheelBindings.delete(wheelId);
            this.bindColorWheel({
                wheelId,
                hiddenId: colorId,
                hexId,
                initialValue: this.normalizeColorValue(role.color || '#cbff00'),
            });
            });
        });
    }

    renderServerChannels() {
        const list = document.getElementById('serverChannelsList');
        const count = document.getElementById('serverChannelsCount');
        const isEdit = this.S.serverModal.mode === 'edit';
        const channels = isEdit ? this.normalizeServerChannels(this.S.serverModal.channels || []) : [];
        if (count) count.textContent = String(channels.length || 0);
        if (!list) return;
        if (this.S.serverModal.loading && channels.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Загрузка каналов</div>
                <div class="empty-sub">Подождите секунду</div>
            </div>`;
            return;
        }
        if (!isEdit) {
            list.innerHTML = '';
            return;
        }
        if (channels.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Каналов нет</div>
                <div class="empty-sub">Создайте первый канал</div>
            </div>`;
            return;
        }
        list.innerHTML = channels.map(channel => {
            const safeId = String(channel.id || '').replace(/[^a-z0-9_-]/gi, '_');
            const kind = this.normalizeChannelKind(channel.kind);
            return `<div class="server-channel-card" data-channel-card="${this.esc(channel.id)}">
                <div class="server-channel-head">
                    <span class="server-channel-chip ${kind}">${this.channelKindIcon(kind, 'server-channel-chip-icon')}</span>
                    <div class="server-channel-copy">
                        <input class="settings-input" data-channel-name="${this.esc(channel.id)}" value="${this.esc(channel.name || '')}" placeholder="Название канала">
                        <div class="server-channel-meta">ID: ${this.esc(channel.id || safeId)} · ${this.esc(this.channelKindLabel(kind))}</div>
                    </div>
                    <select class="settings-input server-channel-kind-select" data-channel-kind="${this.esc(channel.id)}">
                        <option value="text"${kind === 'text' ? ' selected' : ''}>Текстовый</option>
                        <option value="voice"${kind === 'voice' ? ' selected' : ''}>Голосовой</option>
                    </select>
                    <div class="server-channel-controls">
                        <button class="btn-flat" type="button" data-channel-save="${this.esc(channel.id)}">Сохранить</button>
                        <button class="btn-flat" type="button" data-channel-delete="${this.esc(channel.id)}">Удалить</button>
                    </div>
                </div>
                <div class="server-channel-body">
                    <input class="settings-input" data-channel-topic="${this.esc(channel.id)}" value="${this.esc(channel.topic || '')}" placeholder="Тема или описание">
                    <label class="server-channel-position">
                        <span class="server-channel-position-label">Позиция</span>
                        <input class="settings-input" data-channel-position="${this.esc(channel.id)}" type="number" min="0" step="1" value="${this.esc(String(Number.isFinite(Number(channel.position)) ? Number(channel.position) : 0))}" placeholder="0">
                    </label>
                </div>
            </div>`;
        }).join('');
    }

    async openServerModal(mode = 'create', serverId = null) {
        const nextMode = mode === 'edit' ? 'edit' : 'create';
        const sid = nextMode === 'edit' ? String(serverId || this.S.activeServer || '').trim() : null;
        const server = sid ? (this.S.servers || []).find(item => item.id === sid) : null;
        if (nextMode === 'edit' && (!server || !this.canManageServer(server))) {
            return;
        }
        const selectedChannelId = nextMode === 'edit'
            ? ((this.S.activeServer === sid ? this.S.activeChannel : null) || server?.channels?.[0]?.id || null)
            : null;

        this.setServerModalState({
            mode: nextMode,
            serverId: sid,
            activeSection: nextMode === 'edit' ? 'overview' : 'overview',
            colorPickers: {},
            roleCreateOpen: false,
            channelCreateOpen: false,
            members: nextMode === 'edit' ? (server?.members || []) : [],
            roles: [],
            channels: nextMode === 'edit' ? (server?.channels || []) : [],
            draftRoles: [],
            createDraft: nextMode === 'edit' ? null : this.serverCreateDraftDefaults(),
            joinLink: nextMode === 'edit' ? (server?.joinLink || server?.join_link || '') : '',
            selectedChannelId,
            channelPermissions: [],
            loading: nextMode === 'edit',
            saving: false,
            error: '',
        });
        this.openServerOverlay();
        this.renderServerModal();
        if (nextMode === 'create') {
            this.applyServerRoleCreateDefaults();
        }

        if (nextMode === 'edit' && sid) {
            try {
                const [members, roles, channels] = await Promise.all([
                    this.loadServerMembers(sid),
                    this.loadServerRoles(sid),
                    this.loadServerChannels(sid),
                ]);
                this.setServerModalState({
                    members,
                    roles,
                    channels,
                    loading: false,
                });
                this.renderServerModal();
            } catch (e) {
                this.setServerModalState({ loading: false, error: e?.message || 'Не удалось загрузить участников' });
                this.renderServerModal();
            }
        }
    }

    async openPublicServersModal() {
        const discoverQuery = document.getElementById('serverDiscoverQuery');
        if (discoverQuery) discoverQuery.value = '';
        this.setServerModalState({
            mode: 'discover',
            serverId: null,
            activeSection: 'discover',
            colorPickers: {},
            members: [],
            roles: [],
            channels: [],
            draftRoles: [],
            createDraft: null,
            joinLink: '',
            selectedChannelId: null,
            channelPermissions: [],
            channelCreateOpen: false,
            loading: true,
            saving: false,
            error: '',
        });
        this.openServerOverlay();
        this.renderServerModal();
        await this.loadPublicServers({ silent: true });
    }

    publicServerFilterValue() {
        const input = document.getElementById('serverDiscoverQuery');
        return String(input?.value || '').trim().toLowerCase();
    }

    renderFilteredPublicServers() {
        const q = this.publicServerFilterValue();
        const servers = Array.isArray(this.S.publicServers) ? this.S.publicServers : [];
        if (!q) return servers;
        return servers.filter(server => {
            const haystack = `${server.name || ''} ${server.description || server.hint || ''} ${server.joinLink || server.join_link || ''}`.toLowerCase();
            return haystack.includes(q);
        });
    }

    async loadPublicServers({ silent = false } = {}) {
        try {
            this.setServerModalState({ loading: true, error: '' });
            this.renderServerModal();
            const res = await this.apiFetch(this.apiRoutes.discover.servers);
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось загрузить публичные серверы');
            }
            const data = await res.json();
            this.S.publicServers = this.normalizeServers(Array.isArray(data?.servers) ? data.servers : []);
            this.setServerModalState({ loading: false, error: '' });
            this.renderServerModal();
        } catch (e) {
            this.S.publicServers = [];
            this.setServerModalState({
                loading: false,
                error: e?.message || 'Не удалось загрузить публичные серверы',
            });
            this.renderServerModal();
            if (!silent) {
                this.addLogEntry({ type: 'ERROR', msg: e?.message || 'Не удалось загрузить публичные серверы', ts: new Date().toLocaleTimeString() });
            }
        }
    }

    async enterPublicServer(serverIdOrLink) {
        const raw = String(serverIdOrLink || '').trim();
        if (!raw) return;
        await this.joinServerByLink(raw);
        if (this.S.serverModal.mode === 'discover') {
            await this.loadPublicServers({ silent: true });
        }
    }

    async submitServerModal() {
        if (this.S.serverModal.saving) return;
        const mode = this.S.serverModal.mode;
        const serverId = this.S.serverModal.serverId;
        const createDraft = mode === 'edit' ? null : this.syncServerCreateDraftFromDom();
        const nameInput = document.getElementById('serverNameInput');
        const descInput = document.getElementById('serverDescriptionInput');
        const iconInput = document.getElementById('serverIconInput');
        const colorInput = document.getElementById('serverColorInput');
        const joinLinkInput = document.getElementById('serverJoinLinkInput');
        const publicInput = document.getElementById('serverPublicInput');
        const payloadSource = mode === 'edit'
            ? null
            : (createDraft || this.serverCreateDraft());
        const payload = {
            name: (payloadSource ? payloadSource.name : (nameInput?.value || '')).trim(),
            description: (payloadSource ? payloadSource.description : (descInput?.value || '')).trim(),
            icon: (payloadSource ? payloadSource.icon : (iconInput?.value || '')).trim(),
            color: this.normalizeColorValue(payloadSource ? payloadSource.color : (colorInput?.value || '#cbff00')),
            join_link: (payloadSource ? payloadSource.joinLink : (joinLinkInput?.value || '')).trim(),
            is_public: payloadSource ? !!payloadSource.isPublic : !!publicInput?.checked,
        };
        if (mode !== 'edit') {
            payload.roles = this.syncDraftServerRolesFromDom().map(role => {
                const rolePayload = {
                    name: role.name,
                    color: role.color,
                };
                this.serverRolePermissionDefs().forEach(def => {
                    rolePayload[def.key] = !!role[def.key];
                });
                return rolePayload;
            });
        }

        if (!payload.name) {
            this.setServerModalState({ error: 'Введите название сервера' });
            this.renderServerModal();
            return;
        }

        this.setServerModalState({ saving: true, error: '' });
        this.renderServerModal();

        try {
            const endpoint = mode === 'edit' && serverId
                ? this.apiRoutes.servers.byId(serverId)
                : this.apiRoutes.servers.list;
            const res = await this.apiFetch(endpoint, {
                method: mode === 'edit' ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось сохранить сервер');
            }
            const data = await res.json();
            this.closeServerOverlay();
            await this.loadServers({ silent: true });
            if (data?.id) {
                this.setActiveServer(data.id, { persist: true });
            }
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось сохранить сервер' });
            this.renderServerModal();
        } finally {
            this.setServerModalState({ saving: false });
        }
    }

    async uploadServerAsset(kind, file) {
        const serverId = this.S.serverModal.serverId || this.S.activeServer;
        if (!serverId || !file || this.S.serverModal.mode !== 'edit') return;
        const dataUrl = await this.readFileAsDataURL(file);
        const res = await this.apiFetch(this.apiRoutes.servers.assets(serverId, kind), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data_url: dataUrl }),
        });
        if (!res.ok && res.status !== 204) {
            throw new Error(await res.text() || `Не удалось обновить ${kind}`);
        }
        this.clearServerAssetCache(serverId, kind);
        await this.syncServerAssetPreview(serverId);
    }

    async removeServerAsset(kind) {
        const serverId = this.S.serverModal.serverId || this.S.activeServer;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const res = await this.apiFetch(this.apiRoutes.servers.assets(serverId, kind), {
            method: 'DELETE',
        });
        if (!res.ok && res.status !== 204) {
            throw new Error(await res.text() || `Не удалось удалить ${kind}`);
        }
        this.clearServerAssetCache(serverId, kind);
        await this.syncServerAssetPreview(serverId);
    }

    async generateServerJoinLink() {
        if (this.S.serverModal.saving) return '';
        const mode = this.S.serverModal.mode;
        const server = mode === 'edit'
            ? this.currentServer()
            : null;
        const fallback = mode === 'edit' && server?.id
            ? `zali://server/${server.id}`
            : `zali://server/${(document.getElementById('serverNameInput')?.value || 'server').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        if (mode === 'edit') {
            this.setServerModalState({ joinLink: fallback, error: '' });
        } else {
            const draft = this.syncServerCreateDraftFromDom();
            this.setServerModalState({
                joinLink: fallback,
                createDraft: {
                    ...draft,
                    joinLink: fallback,
                },
                error: '',
            });
        }
        this.renderServerModal();
        return fallback;
    }

    async joinServerByLink(link) {
        const raw = String(link || '').trim();
        if (!raw) return;
        const inviteMatch = raw.match(/(?:zali:\/\/invite\/|invite\/)?([a-z0-9]{4,64})/i);
        if (inviteMatch && /invite/i.test(raw)) {
            const inviteCode = inviteMatch[1].toLowerCase();
            try {
                const res = await this.apiFetch(this.apiRoutes.invites.join(inviteCode), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: inviteCode }),
                });
                if (!res.ok) {
                    throw new Error(await res.text() || 'Не удалось войти по ссылке');
                }
                const data = await res.json();
                await this.loadServers({ silent: true });
                this.closeServerOverlay();
                if (data?.serverId) {
                    this.setActiveServer(data.serverId, { persist: true });
                }
                this.addLogEntry({ type: 'SUCCESS', msg: `Вход по ссылке успешен: ${inviteCode}`, ts: new Date().toLocaleTimeString() });
            } catch (e) {
                this.addLogEntry({ type: 'ERROR', msg: e?.message || 'Не удалось войти по ссылке', ts: new Date().toLocaleTimeString() });
            }
            return;
        }

        try {
            const res = await this.apiFetch(this.apiRoutes.servers.join, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ link: raw }),
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось войти по ссылке');
            }
            const data = await res.json();
            await this.loadServers({ silent: true });
            this.closeServerOverlay();
            if (data?.serverId) {
                this.setActiveServer(data.serverId, { persist: true });
            }
            this.addLogEntry({ type: 'SUCCESS', msg: `Вход по ссылке успешен`, ts: new Date().toLocaleTimeString() });
        } catch (e) {
            this.addLogEntry({ type: 'ERROR', msg: e?.message || 'Не удалось войти по ссылке', ts: new Date().toLocaleTimeString() });
        }
    }

    extractInviteCode(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const match = raw.match(/(?:zali:\/\/invite\/|invite\/|zali:\/\/server\/|server\/)?([a-z0-9._-]{2,128})/i);
        return (match && match[1]) ? match[1].toLowerCase() : raw.toLowerCase();
    }

    rolePayloadFromCreateForm() {
        const nameInput = document.getElementById('serverRoleNameInput');
        const colorInput = document.getElementById('serverRoleColorInput');
        const colorHexInput = document.getElementById('serverRoleColorHexInput');
        const permissions = {};
        this.serverRolePermissionDefs().forEach(def => {
            permissions[def.key] = !!document.querySelector(`[data-server-role-perm="${CSS.escape(def.key)}"]`)?.checked;
        });
        return {
            name: (nameInput?.value || '').trim(),
            color: this.normalizeColorValue(colorInput?.value || colorHexInput?.value || '#cbff00'),
            ...permissions,
        };
    }

    rolePayloadFromCard(roleId) {
        const card = document.querySelector(`[data-role-card="${CSS.escape(String(roleId || ''))}"]`);
        if (!card) return null;
        const name = String(card.querySelector(`[data-role-name="${CSS.escape(String(roleId || ''))}"]`)?.value || '').trim();
        const color = this.normalizeColorValue(card.querySelector(`[data-role-color="${CSS.escape(String(roleId || ''))}"]`)?.value || '#cbff00');
        const permissions = {};
        this.serverRolePermissionDefs().forEach(def => {
            permissions[def.key] = !!card.querySelector(`[data-role-perm="${CSS.escape(def.key)}"]`)?.checked;
        });
        return {
            name,
            color,
            ...permissions,
        };
    }

    async createServerRole() {
        const payload = this.rolePayloadFromCreateForm();
        if (!payload.name) {
            this.setServerModalState({ error: 'Введите название роли' });
            this.renderServerModal();
            return;
        }
        if (this.S.serverModal.mode === 'create') {
            const draftRoles = this.syncDraftServerRolesFromDom();
            const draftPermissions = {};
            this.serverRolePermissionDefs().forEach(def => {
                draftPermissions[def.key] = !!payload[def.key];
            });
            draftRoles.push({
                draftId: `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                collapsed: true,
                name: payload.name,
                color: payload.color,
                ...draftPermissions,
            });
            this.setServerModalState({ draftRoles, error: '' });
            const nameInput = document.getElementById('serverRoleNameInput');
            if (nameInput) nameInput.value = '';
            this.applyServerRoleCreateDefaults();
            this.renderServerModal();
            return;
        }
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const res = await this.apiFetch(this.apiRoutes.servers.roles(serverId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось создать роль');
        }
        const role = await res.json();
        const roles = [role, ...(this.S.serverModal.roles || [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
        this.setServerModalState({ roles, error: '' });
        const nameInput = document.getElementById('serverRoleNameInput');
        if (nameInput) nameInput.value = '';
        this.renderServerModal();
        this.applyServerRoleCreateDefaults();
        await this.loadServers({ silent: true });
    }

    async saveServerRole(roleId) {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const payload = this.rolePayloadFromCard(roleId);
        if (!payload) return;
        const res = await this.apiFetch(this.apiRoutes.servers.role(serverId, roleId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось сохранить роль');
        }
        const updated = await res.json();
        const roles = (this.S.serverModal.roles || []).map(role => String(role.roleId || '') === roleId ? updated : role);
        this.setServerModalState({ roles, error: '' });
        this.renderServerModal();
        await this.loadServers({ silent: true });
    }

    async deleteServerRole(roleId) {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const res = await this.apiFetch(this.apiRoutes.servers.role(serverId, roleId), {
            method: 'DELETE',
        });
        if (!res.ok && res.status !== 204) {
            throw new Error(await res.text() || 'Не удалось удалить роль');
        }
        const roles = (this.S.serverModal.roles || []).filter(role => String(role.roleId || '') !== roleId);
        this.setServerModalState({ roles, error: '' });
        this.renderServerModal();
        await this.loadServers({ silent: true });
    }

    async saveServerMembersFromModal() {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        try {
            const members = await this.loadServerMembers(serverId);
            this.setServerModalState({ members });
            this.renderServerModal();
            await this.loadServers({ silent: true });
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось обновить участников' });
            this.renderServerModal();
        }
    }

    channelPayloadFromCreateForm() {
        const nameInput = document.getElementById('serverChannelNameInput');
        const topicInput = document.getElementById('serverChannelTopicInput');
        const kindInput = document.getElementById('serverChannelKindInput');
        return {
            name: (nameInput?.value || '').trim(),
            topic: (topicInput?.value || '').trim(),
            kind: this.normalizeChannelKind(kindInput?.value || 'text'),
        };
    }

    channelPayloadFromCard(channelId) {
        const card = document.querySelector(`[data-channel-card="${CSS.escape(String(channelId || ''))}"]`);
        if (!card) return null;
        const name = String(card.querySelector(`[data-channel-name="${CSS.escape(String(channelId || ''))}"]`)?.value || '').trim();
        const topic = String(card.querySelector(`[data-channel-topic="${CSS.escape(String(channelId || ''))}"]`)?.value || '').trim();
        const kind = this.normalizeChannelKind(card.querySelector(`[data-channel-kind="${CSS.escape(String(channelId || ''))}"]`)?.value || 'text');
        const positionValue = String(card.querySelector(`[data-channel-position="${CSS.escape(String(channelId || ''))}"]`)?.value || '').trim();
        const position = positionValue === '' ? undefined : Number(positionValue);
        return {
            name,
            topic,
            kind,
            position: Number.isFinite(position) ? position : undefined,
        };
    }

    async createServerChannel() {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const payload = this.channelPayloadFromCreateForm();
        if (!payload.name) {
            this.setServerModalState({ error: 'Введите название канала' });
            this.renderServerModal();
            return;
        }
        this.setServerModalState({ saving: true, error: '' });
        this.renderServerModal();
        try {
            const res = await this.apiFetch(this.apiRoutes.servers.channels(serverId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось создать канал');
            }
            const data = await res.json();
            const channels = this.normalizeServerChannels(Array.isArray(data) ? data : (Array.isArray(data?.channels) ? data.channels : []));
            const nameInput = document.getElementById('serverChannelNameInput');
            const topicInput = document.getElementById('serverChannelTopicInput');
            if (nameInput) nameInput.value = '';
            if (topicInput) topicInput.value = '';
            this.setServerModalState({ channels, error: '' });
            await this.loadServers({ silent: true });
            if (this.S.activeServer === serverId) {
                this.setActiveServer(serverId, { persist: true });
            }
            this.renderServerModal();
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось создать канал' });
            this.renderServerModal();
        } finally {
            this.setServerModalState({ saving: false });
        }
    }

    async saveServerChannel(channelId) {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const cid = String(channelId || '').trim();
        const payload = this.channelPayloadFromCard(cid);
        if (!payload || !payload.name) {
            this.setServerModalState({ error: 'Введите название канала' });
            this.renderServerModal();
            return;
        }
        this.setServerModalState({ saving: true, error: '' });
        this.renderServerModal();
        try {
            const res = await this.apiFetch(this.apiRoutes.servers.channel(serverId, cid), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось сохранить канал');
            }
            const data = await res.json();
            const channels = this.normalizeServerChannels(Array.isArray(data) ? data : (Array.isArray(data?.channels) ? data.channels : []));
            this.setServerModalState({ channels, error: '' });
            await this.loadServers({ silent: true });
            if (this.S.activeServer === serverId) {
                this.setActiveServer(serverId, { persist: true });
            }
            this.renderServerModal();
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось сохранить канал' });
            this.renderServerModal();
        } finally {
            this.setServerModalState({ saving: false });
        }
    }

    async deleteServerChannel(channelId) {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const cid = String(channelId || '').trim();
        const channel = (this.S.serverModal.channels || []).find(item => String(item.id || '') === cid);
        const confirmDelete = confirm(`Удалить канал "${channel?.name || cid}"?`);
        if (!confirmDelete) return;
        this.setServerModalState({ saving: true, error: '' });
        this.renderServerModal();
        try {
            const res = await this.apiFetch(this.apiRoutes.servers.channel(serverId, cid), {
                method: 'DELETE',
            });
            if (!res.ok && res.status !== 204) {
                throw new Error(await res.text() || 'Не удалось удалить канал');
            }
            let channels = [];
            if (res.status !== 204) {
                const data = await res.json();
                channels = this.normalizeServerChannels(Array.isArray(data) ? data : (Array.isArray(data?.channels) ? data.channels : []));
            }
            this.setServerModalState({ channels, error: '' });
            await this.loadServers({ silent: true });
            if (this.S.activeServer === serverId) {
                this.setActiveServer(serverId, { persist: true });
            }
            this.renderServerModal();
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось удалить канал' });
            this.renderServerModal();
        } finally {
            this.setServerModalState({ saving: false });
        }
    }

    currentServer() {
        return (this.S.servers || []).find(server => server.id === this.S.activeServer) || null;
    }

    currentChannel() {
        const server = this.currentServer();
        if (!server) return null;
        return (server.channels || []).find(channel => channel.id === this.S.activeChannel) || null;
    }

    currentServerChatKey() {
        if (!this.S.activeServer || !this.S.activeChannel) return '';
        return `${this.S.activeServer}:${this.S.activeChannel}`;
    }

    currentConversationMode() {
        const renderedKey = String(this.lastRenderedConversationKey || '').trim();
        const serverKey = this.currentServerChatKey();
        const dmKey = String(this.S.current || '').trim();

        if (this.S.navMode === 'servers' && renderedKey && serverKey && renderedKey === serverKey) {
            return 'servers';
        }
        if (dmKey) {
            return 'dm';
        }
        if (this.S.navMode === 'servers' && serverKey) {
            return 'servers';
        }
        return 'dm';
    }

    clearActiveServerSelection({ persist = true } = {}) {
        this.S.activeServer = null;
        this.S.activeChannel = null;
        this.S.activeConversationType = 'dm';
        if (persist) {
            this.saveStoredActiveServer(null);
            this.saveStoredActiveChannel(null);
        }
    }

    voiceRoomKeyForDm(peer) {
        const me = String(this.myName() || '').trim();
        const other = String(peer || '').trim();
        const pair = [me, other].filter(Boolean).sort();
        return pair.length === 2 ? `voice:dm:${pair.join(':')}` : '';
    }

    makeDmCallRoomId(peer) {
        const base = this.voiceRoomKeyForDm(peer);
        if (!base) return '';
        const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        return `${base}:${stamp}`;
    }

    voiceRoomKeyForChannel(serverId, channelId) {
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        return sid && cid ? `voice:channel:${sid}:${cid}` : '';
    }

    isVoiceChannel(channel = null) {
        return String(channel?.kind || '').trim().toLowerCase() === 'voice';
    }

    currentVoicePeer() {
        if (this.S.navMode === 'dm') {
            return String(this.S.current || '').trim();
        }
        return '';
    }

    shouldInitiateVoiceOffer(peer) {
        const me = String(this.myName() || '').trim();
        const other = String(peer || '').trim();
        if (!me || !other) return false;
        if (this.voice.roomType === 'dm') {
            const direction = String(this.voice.callTrack?.direction || '').trim();
            return direction === 'outgoing' && this.voice.status === 'connected';
        }
        return me.localeCompare(other) < 0;
    }

    voiceEventPayload(payload = {}) {
        return {
            ...payload,
            type: payload.type || 'voice_signal',
        };
    }

    sendVoiceEvent(payload = {}) {
        const event = this.voiceEventPayload(payload);
        this.voiceTrace('send-event', {
            type: event.type || '',
            roomId: event.roomId || '',
            roomType: event.roomType || '',
            to: event.to || '',
            signalType: event.signal?.type || '',
            participants: Array.isArray(this.voice.participants) ? this.voice.participants : [],
        });
        if (!this.nativeSupports('voice')) {
            if (this.voice.socket && this.voice.socket.readyState === WebSocket.OPEN) {
                try {
                    this.voice.socket.send(JSON.stringify(event));
                } catch (error) {
                    this.voiceTrace('send-event-failed', { type: event.type || '', error: error?.message || String(error) }, 'ERROR');
                    return false;
                }
                return true;
            }
            this.addLogEntry({
                type: 'WARN',
                msg: `Voice signal skipped in browser mode: ${event.type}`,
                ts: new Date().toLocaleTimeString(),
            });
            return false;
        }
        this.postNativeMessage({
            type: NativeMessageTypes.VOICE_EVENT,
            payload: event,
        });
        return true;
    }

    disconnectBrowserVoiceSocket() {
        this.voiceTrace('socket-disconnect', { generation: this.voiceSocketGeneration, hadSocket: !!this.voice.socket });
        this.voiceSocketGeneration += 1;
        this.voiceSocketReconnectDelayMs = 1000;
        if (this.voiceSocketPingTimer) {
            clearInterval(this.voiceSocketPingTimer);
            this.voiceSocketPingTimer = null;
        }
        if (this.voiceSocketReconnectTimer) {
            clearTimeout(this.voiceSocketReconnectTimer);
            this.voiceSocketReconnectTimer = null;
        }
        if (this.voice.socket) {
            try {
                this.voice.socket.onopen = null;
                this.voice.socket.onmessage = null;
                this.voice.socket.onclose = null;
                this.voice.socket.onerror = null;
                this.voice.socket.close();
            } catch (e) {}
        }
        this.voice.socket = null;
        this.voice.socketReady = false;
    }

    scheduleBrowserVoiceSocketReconnect(generation, reason = 'retry') {
        if (this.nativeSupports('voice')) return;
        const baseDelay = this.voiceSocketReconnectDelayMs || 1000;
        const jitter = Math.floor(Math.random() * 500);
        const delay = Math.min(baseDelay + jitter, 30000);
        this.voiceSocketReconnectDelayMs = Math.min(baseDelay * 2, 30000);
        this.voiceTrace('socket-reconnect-scheduled', { generation, reason, delay }, 'WARN');
        if (this.voiceSocketReconnectTimer) {
            clearTimeout(this.voiceSocketReconnectTimer);
            this.voiceSocketReconnectTimer = null;
        }
        this.voiceSocketReconnectTimer = setTimeout(() => {
            if (generation === this.voiceSocketGeneration) {
                this.connectBrowserVoiceSocket();
            }
        }, delay);
    }

    async fetchBrowserVoiceSocketTicket() {
        if (!this.S.session?.token) return '';
        const res = await this.apiFetch(this.apiRoutes.auth.wsTicket, { method: 'POST' });
        if (!res.ok) {
            throw new Error(await res.text().catch(() => 'Не удалось получить ws-ticket'));
        }
        const data = await res.json().catch(() => null);
        return String(data?.ticket || '').trim();
    }

    async connectBrowserVoiceSocket() {
        if (this.nativeSupports('voice')) return;
        if (typeof WebSocket === 'undefined') return;
        if (this.voice.socket && (this.voice.socket.readyState === WebSocket.OPEN || this.voice.socket.readyState === WebSocket.CONNECTING)) {
            return;
        }

        this.disconnectBrowserVoiceSocket();
        const generation = ++this.voiceSocketGeneration;
        let url;
        try {
            url = new URL(this.getWsBaseUrl());
        } catch (error) {
            this.addLogEntry({ type: 'ERROR', msg: `Неверный WS URL: ${error?.message || error}`, ts: new Date().toLocaleTimeString() });
            return;
        }

        let ticket = '';
        try {
            ticket = await this.fetchBrowserVoiceSocketTicket();
        } catch (error) {
            this.addLogEntry({ type: 'ERROR', msg: `Не удалось получить ws-ticket: ${error?.message || error}`, ts: new Date().toLocaleTimeString() });
            this.scheduleBrowserVoiceSocketReconnect(generation, 'ticket-fetch-error');
            return;
        }
        if (!ticket) {
            this.addLogEntry({ type: 'ERROR', msg: 'Не удалось получить ws-ticket для voice socket', ts: new Date().toLocaleTimeString() });
            this.scheduleBrowserVoiceSocketReconnect(generation, 'ticket-missing');
            return;
        }
        if (generation !== this.voiceSocketGeneration) {
            return;
        }
        url.searchParams.set('ticket', ticket);

        try {
            this.voiceTrace('socket-connect', { url: url.toString(), generation, auth: 'ws-ticket' });
            const socket = new WebSocket(url.toString());
            this.voice.socket = socket;
            this.voice.socketReady = false;

            socket.onopen = () => {
                if (generation !== this.voiceSocketGeneration) return;
                this.voice.socketReady = true;
                this.voiceSocketReconnectDelayMs = 1000;
                if (this.voiceSocketPingTimer) {
                    clearInterval(this.voiceSocketPingTimer);
                    this.voiceSocketPingTimer = null;
                }
                this.voiceSocketPingTimer = setInterval(() => {
                    if (generation !== this.voiceSocketGeneration) return;
                    if (!this.voice.socket || this.voice.socket.readyState !== WebSocket.OPEN) return;
                    try {
                        this.voice.socket.send(JSON.stringify({ type: 'ping' }));
                    } catch (e) {}
                }, 25000);
                this.voiceTrace('socket-open', { generation, url: url.toString() }, 'SUCCESS');
                this.addLogEntry({ type: 'SUCCESS', msg: 'Browser voice socket connected', ts: new Date().toLocaleTimeString() });
                // This socket doubles as the pure-browser client's only realtime connection
                // (messages + voice signaling both ride it — see onmessage below), so its
                // lifecycle IS the connection-status badge in that mode, same as native
                // shells driving it via SET_CONNECTION_STATUS over their own transport.
                this.setConnectionStatus(true);
            };

            socket.onmessage = (event) => {
                if (generation !== this.voiceSocketGeneration) return;
                let payload = null;
                try {
                    payload = JSON.parse(event.data);
                } catch (e) {
                    return;
                }
                if (payload && typeof payload === 'object' && String(payload.type || '').startsWith('voice_')) {
                    this.handleVoiceEvent(payload);
                } else if (payload && typeof payload === 'object' && !payload.type && payload.id && payload.sender && payload.receiver) {
                    // No `type` field = a raw `Message` row pushed by deliver_to_user/
                    // deliver_server_message (server/src/realtime.rs), not a voice/avatar
                    // event. Only reachable in pure-browser mode — native shells receive
                    // and decrypt these themselves over their own transport.
                    void this.handleIncomingBrowserMessage(payload);
                }
            };

            socket.onclose = () => {
                if (generation !== this.voiceSocketGeneration) return;
                this.voice.socketReady = false;
                this.voice.socket = null;
                if (this.voiceSocketPingTimer) {
                    clearInterval(this.voiceSocketPingTimer);
                    this.voiceSocketPingTimer = null;
                }
                this.voiceTrace('socket-close', { generation, url: url.toString() }, 'WARN');
                this.setConnectionStatus(false);
                if (!this.nativeSupports('voice')) {
                    const baseDelay = this.voiceSocketReconnectDelayMs || 1000;
                    const jitter = Math.floor(Math.random() * 500);
                    const delay = Math.min(baseDelay + jitter, 30000);
                    this.voiceSocketReconnectDelayMs = Math.min(baseDelay * 2, 30000);
                    this.voiceSocketReconnectTimer = setTimeout(() => {
                        if (generation === this.voiceSocketGeneration) {
                            this.connectBrowserVoiceSocket();
                        }
                    }, delay);
                }
            };

            socket.onerror = () => {
                if (generation !== this.voiceSocketGeneration) return;
                this.voice.socketReady = false;
                this.voiceTrace('socket-error', { generation, url: url.toString() }, 'WARN');
            };
        } catch (error) {
            this.addLogEntry({ type: 'ERROR', msg: `Не удалось подключить browser voice socket: ${error?.message || error}`, ts: new Date().toLocaleTimeString() });
        }
    }

    voiceRoomSummary() {
        const roomLabel = this.voice.roomType === 'channel'
            ? (this.currentChannel() ? `#${this.currentChannel().name}` : 'Голосовой канал')
            : this.voice.roomType === 'dm'
                ? `Звонок с ${this.voice.targetUser || this.voice.inviter || ''}`.trim()
                : 'Голос';
        return roomLabel;
    }

    resetVoiceState({ preserveInvite = false } = {}) {
        this.voiceTrace('reset-state', { preserveInvite, roomId: this.voice.roomId || '', roomType: this.voice.roomType || '', status: this.voice.status || '' });
        for (const entry of this.voice.peerConnections.values()) {
            if (entry.reconnectTimer) {
                clearTimeout(entry.reconnectTimer);
                entry.reconnectTimer = null;
            }
            if (entry.healthTimer) {
                clearTimeout(entry.healthTimer);
                entry.healthTimer = null;
            }
            if (entry.statsTimer) {
                clearInterval(entry.statsTimer);
                entry.statsTimer = null;
            }
            try { entry.pc?.close(); } catch (e) {}
        }
        this.voice.peerConnections.clear();
        for (const audio of this.voice.remoteAudios.values()) {
            try {
                audio.pause?.();
                if (audio.srcObject) {
                    audio.srcObject = null;
                }
                audio.remove?.();
            } catch (e) {}
        }
        this.voice.remoteAudios.clear();
        if (this.voice.localStream) {
            for (const track of this.voice.localStream.getTracks()) {
                try { track.stop(); } catch (e) {}
            }
        }
        this.voice.localStream = null;
        if (this.voice.audioContext) {
            try { this.voice.audioContext.close?.(); } catch (e) {}
        }
        this.voice.audioContext = null;
        this.voice.playbackUnlocked = false;
        this.voice.meterUiRenderedOnce = false;
        this.voice.meterLevels = { local: 0, remote: 0 };
        this.voice.meterLocal = null;
        this.voice.meterRemote.clear();
        if (this.voice.remotePlaybackNodes) {
            for (const node of this.voice.remotePlaybackNodes.values()) {
                try { node?.source?.disconnect?.(); } catch (e) {}
                try { node?.splitter?.disconnect?.(); } catch (e) {}
                try { node?.gain?.disconnect?.(); } catch (e) {}
            }
            this.voice.remotePlaybackNodes.clear();
        }
        this.stopVoiceMeterLoop();
        this.voice.traceLines = [];
        this.voice.roomId = '';
        this.voice.roomType = '';
        this.voice.serverId = '';
        this.voice.channelId = '';
        this.voice.targetUser = '';
        this.voice.inviter = '';
        this.voice.participants = [];
        this.voice.status = 'idle';
        this.voice.muted = false;
        this.voice.callTrack = null;
        if (!preserveInvite) {
            this.voice.incomingInvite = null;
            this.voice.outgoingInvite = null;
        }
        this.renderVoicePanel();
        this.scheduleRenderMessages();
    }

    async ensureVoiceLocalStream() {
        if (this.voice.localStream) return this.voice.localStream;
        if (!this.voice.supported) {
            throw new Error('Голосовые звонки не поддерживаются в этом окружении');
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        this.voice.localStream = stream;
        this.voice.muted = false;
        this.voiceTrace('local-stream-ready', {
            tracks: stream.getTracks().map(track => `${track.kind}:${track.readyState}:${track.enabled ? 'on' : 'off'}`),
        });
        this.ensureVoiceMeterLoop();
        return stream;
    }

    async unlockVoicePlayback() {
        if (this.voice.playbackUnlocked) return true;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
                if (!this.voice.audioContext) {
                    this.voice.audioContext = new AudioCtx();
                }
            if (this.voice.audioContext.state === 'suspended') {
                await this.voice.audioContext.resume();
            }
            }
            this.voice.playbackUnlocked = true;
            this.ensureVoiceMeterLoop();
            this.voiceTrace('audio-unlock', {
                contextState: this.voice.audioContext?.state || 'none',
            }, 'SUCCESS');
            return true;
        } catch (error) {
            this.voiceTrace('audio-unlock-failed', { error: error?.message || String(error) }, 'WARN');
            return false;
        }
    }

    getVoicePeerEntry(peer) {
        const name = String(peer || '').trim();
        if (!name) return null;
        let entry = this.voice.peerConnections.get(name);
        if (!entry) {
            this.voiceTrace('peer-create', {
                peer: name,
                roomId: this.voice.roomId || '',
                roomType: this.voice.roomType || '',
                supported: this.voice.supported,
            });
            entry = {
                pc: new RTCPeerConnection(this.getVoiceRtcConfig()),
                localTracksAttached: false,
                offerSent: false,
                pendingIceCandidates: [],
                statsTimer: null,
                healthTimer: null,
                audioSender: null,
                generatedIceCandidates: 0,
                receivedIceCandidates: 0,
            };
            const rtcConfig = entry.pc.getConfiguration?.() || this.getVoiceRtcConfig();
            this.voiceTrace('rtc-config', {
                peer: name,
                policy: rtcConfig.iceTransportPolicy || 'all',
                servers: (rtcConfig.iceServers || []).map(server => ({
                    urls: server.urls,
                    username: server.username ? 'set' : '',
                })),
            });
            entry.statsTimer = setInterval(() => this.sampleVoicePeerStats(name), 5000);
            entry.pc.onicecandidate = (event) => {
                if (event.candidate) {
                    entry.generatedIceCandidates = (entry.generatedIceCandidates || 0) + 1;
                    this.voiceTrace('ice-candidate', {
                        peer: name,
                        index: entry.generatedIceCandidates,
                        mid: event.candidate.sdpMid,
                        line: event.candidate.sdpMLineIndex,
                        protocol: this.describeIceCandidate(event.candidate.candidate).protocol,
                        candidateType: this.describeIceCandidate(event.candidate.candidate).type,
                        address: this.describeIceCandidate(event.candidate.candidate).address,
                    });
                    // ICE candidates arrive in bursts (dozens within a second); a full
                    // panel re-render per candidate is wasted work — coalesce them.
                    this.scheduleRenderVoicePanel();
                } else {
                    this.voiceTrace('ice-candidate-end', {
                        peer: name,
                        count: entry.generatedIceCandidates || 0,
                        state: entry.pc.iceGatheringState,
                    });
                }
                if (!event.candidate || !this.voice.roomId) return;
                this.sendVoiceEvent({
                    type: 'voice_signal',
                    roomId: this.voice.roomId,
                    roomType: this.voice.roomType,
                    serverId: this.voice.serverId,
                    channelId: this.voice.channelId,
                    to: name,
                    signal: {
                        type: 'ice',
                        candidate: {
                            candidate: event.candidate.candidate,
                            sdpMid: event.candidate.sdpMid,
                            sdpMLineIndex: event.candidate.sdpMLineIndex,
                            usernameFragment: event.candidate.usernameFragment || null,
                        },
                    },
                });
            };
            entry.pc.onicecandidateerror = (event) => {
                this.voiceTrace('ice-candidate-error', {
                    peer: name,
                    errorCode: event?.errorCode || '',
                    errorText: event?.errorText || '',
                    url: event?.url || '',
                    roomId: this.voice.roomId || '',
                }, 'WARN');
            };
            entry.pc.onicegatheringstatechange = () => {
                this.voiceTrace('ice-gathering', { peer: name, state: entry.pc.iceGatheringState, roomId: this.voice.roomId || '' });
            };
            entry.pc.oniceconnectionstatechange = () => {
                this.voiceTrace('ice-connection', { peer: name, state: entry.pc.iceConnectionState, roomId: this.voice.roomId || '' });
            };
            entry.pc.onsignalingstatechange = () => {
                this.voiceTrace('signaling-state', { peer: name, state: entry.pc.signalingState, roomId: this.voice.roomId || '' });
            };
            entry.pc.ontrack = (event) => {
                const stream = event.streams?.[0] || new MediaStream([event.track]);
                const track = event.track;
                if (track) {
                    track.onunmute = () => this.voiceTrace('remote-track-unmute', { peer: name, kind: track.kind, readyState: track.readyState }, 'INFO');
                    track.onmute = () => this.voiceTrace('remote-track-mute', { peer: name, kind: track.kind, readyState: track.readyState }, 'WARN');
                    track.onended = () => this.voiceTrace('remote-track-ended', { peer: name, kind: track.kind, readyState: track.readyState }, 'WARN');
                }
                this.voiceTrace('remote-track', {
                    peer: name,
                    kind: event.track?.kind || 'unknown',
                    readyState: event.track?.readyState || '',
                    streamId: stream.id || '',
                    transceiverDirection: event.transceiver?.direction || '',
                    transceiverCurrentDirection: event.transceiver?.currentDirection || '',
                    receiverTrack: event.receiver?.track ? `${event.receiver.track.kind}:${event.receiver.track.readyState}:${event.receiver.track.enabled ? 'on' : 'off'}` : '',
                    tracks: stream.getTracks().map(t => `${t.kind}:${t.readyState}:${t.enabled ? 'on' : 'off'}`),
                });
                this.attachRemoteVoiceStream(name, stream);
            };
            entry.pc.onconnectionstatechange = () => {
                const state = entry.pc.connectionState;
                if (entry.lastConnectionState !== state) {
                    this.voiceTrace('pc-state', { peer: name, from: entry.lastConnectionState || '', to: state, roomId: this.voice.roomId || '' });
                    entry.lastConnectionState = state;
                }
                if (state === 'connected' || state === 'completed') {
                    if (entry.reconnectTimer) {
                        clearTimeout(entry.reconnectTimer);
                        entry.reconnectTimer = null;
                    }
                    if (entry.healthTimer) {
                        clearTimeout(entry.healthTimer);
                        entry.healthTimer = null;
                    }
                    if (!entry.statsTimer) {
                        entry.statsTimer = setInterval(() => this.sampleVoicePeerStats(name), 10000);
                    }
                    this.voice.status = 'connected';
                    if (this.voice.callTrack && !this.voice.callTrack.connectedAt) {
                        this.voice.callTrack.connectedAt = Date.now();
                        this.voice.callTrack.outcome = 'connected';
                    }
                    this.renderVoicePanel();
                    return;
                }
                if (state === 'connecting' || state === 'checking') {
                    if (entry.reconnectTimer) {
                        clearTimeout(entry.reconnectTimer);
                        entry.reconnectTimer = null;
                    }
                    if (entry.healthTimer) {
                        clearTimeout(entry.healthTimer);
                        entry.healthTimer = null;
                    }
                    if (this.voice.status !== 'connected') {
                        this.voice.status = 'connecting';
                        this.renderVoicePanel();
                    }
                    const isDmCall = this.voice.roomType === 'dm';
                    const shouldWatchHealth = isDmCall;
                    if (shouldWatchHealth && !entry.healthTimer) {
                        entry.healthTimer = setTimeout(async () => {
                            entry.healthTimer = null;
                            const currentState = entry.pc?.connectionState || '';
                            const currentIce = entry.pc?.iceConnectionState || '';
                            const stats = entry.lastStats || {};
                            const hasTraffic = Number(stats.inBytes || 0) > 0 || Number(stats.outBytes || 0) > 0;
                            if (!this.voice.roomId) return;
                            if (['connected', 'completed'].includes(currentState)) return;
                            if (hasTraffic) return;
                            if (!['new', 'checking', 'connecting'].includes(currentState) && !['new', 'checking'].includes(currentIce)) return;
                            this.voiceTrace('health-restart', {
                                peer: name,
                                roomId: this.voice.roomId || '',
                                state: currentState,
                                ice: currentIce,
                                hasTraffic,
                            }, 'WARN');
                            try {
                                await this.restartVoicePeer(name);
                            } catch (error) {
                                this.addLogEntry({
                                    type: 'WARN',
                                    msg: error?.message || `Не удалось выполнить ICE restart для ${name}`,
                                    ts: new Date().toLocaleTimeString(),
                                });
                            }
                        }, 8000);
                    }
                    return;
                }
                if (state === 'disconnected' || state === 'failed') {
                    this.addLogEntry({ type: 'WARN', msg: `Voice peer ${name} connection ${state}`, ts: new Date().toLocaleTimeString() });
                    if (entry.reconnectTimer) {
                        clearTimeout(entry.reconnectTimer);
                    }
                    if (entry.healthTimer) {
                        clearTimeout(entry.healthTimer);
                        entry.healthTimer = null;
                    }
                    if (entry.statsTimer) {
                        clearInterval(entry.statsTimer);
                        entry.statsTimer = null;
                    }
                    const isDmCall = this.voice.roomType === 'dm';
                    const allowAutoRestart = true;
                    if (allowAutoRestart) {
                        const delay = state === 'failed' ? 8000 : 10000;
                        entry.reconnectTimer = setTimeout(async () => {
                            entry.reconnectTimer = null;
                            if (!this.voice.roomId) return;
                            if (!['disconnected', 'failed'].includes(entry.pc.connectionState)) return;
                            try {
                                await this.restartVoicePeer(name);
                            } catch (error) {
                                this.addLogEntry({ type: 'WARN', msg: error?.message || `Не удалось восстановить голосовую связь с ${name}`, ts: new Date().toLocaleTimeString() });
                            }
                        }, delay);
                    }
                    if (!isDmCall && this.voice.status !== 'connected') {
                        this.voice.status = 'connecting';
                        this.renderVoicePanel();
                    }
                }
            };
            this.voice.peerConnections.set(name, entry);
        }
        return entry;
    }

    async flushPendingVoiceIceCandidates(entry, peer) {
        if (!entry || !entry.pendingIceCandidates?.length) return;
        const pending = entry.pendingIceCandidates.splice(0, entry.pendingIceCandidates.length);
        this.voiceTrace('ice-flush', { peer, count: pending.length, roomId: this.voice.roomId || '' });
        for (const candidate of pending) {
            try {
                await entry.pc.addIceCandidate(candidate);
            } catch (e) {
                console.warn(`Failed to flush ICE candidate for ${peer}`, e);
            }
        }
    }

    async sampleVoicePeerStats(peer) {
        const name = String(peer || '').trim();
        if (!name) return;
        const entry = this.voice.peerConnections.get(name);
        if (!entry?.pc) return;
        try {
            const stats = await entry.pc.getStats();
            const summary = {
                peer: name,
                connection: entry.pc.connectionState,
                ice: entry.pc.iceConnectionState,
                signaling: entry.pc.signalingState,
                localCandidateCount: entry.generatedIceCandidates || 0,
                remoteCandidateCount: entry.receivedIceCandidates || 0,
            };
            const candidatesById = {};
            stats.forEach(report => {
                if (report.type === 'outbound-rtp' && report.kind === 'audio') {
                    summary.outBytes = report.bytesSent;
                    summary.outPackets = report.packetsSent;
                    summary.outAudioLevel = report.audioLevel;
                    summary.outHeaderBytes = report.headerBytesSent;
                }
                if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                    summary.inBytes = report.bytesReceived;
                    summary.inPackets = report.packetsReceived;
                    summary.inAudioLevel = report.audioLevel;
                    summary.inJitter = report.jitter;
                    summary.inHeaderBytes = report.headerBytesReceived;
                }
                if (report.type === 'track' && report.kind === 'audio') {
                    summary.trackAudioLevel = report.audioLevel;
                    summary.trackMuted = report.muted;
                    summary.trackEnded = report.ended;
                }
                if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
                    summary.candidatePair = {
                        local: report.localCandidateId || '',
                        remote: report.remoteCandidateId || '',
                        currentRoundTripTime: report.currentRoundTripTime,
                        availableOutgoingBitrate: report.availableOutgoingBitrate,
                        bytesSent: report.bytesSent,
                        bytesReceived: report.bytesReceived,
                    };
                }
                if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
                    const candidate = {
                        candidateType: report.candidateType,
                        ip: report.ip || report.address,
                        port: report.port,
                        protocol: report.protocol,
                        priority: report.priority,
                    };
                    candidatesById[report.id] = candidate;
                    summary[`${report.type.replace('-', '')}_${report.id || 'unknown'}`] = candidate;
                }
            });
            if (summary.candidatePair) {
                const local = candidatesById[summary.candidatePair.local];
                const remote = candidatesById[summary.candidatePair.remote];
                summary.candidatePair.localLabel = local ? `${local.candidateType}/${local.protocol}/${local.ip || ''}:${local.port || ''}` : summary.candidatePair.local;
                summary.candidatePair.remoteLabel = remote ? `${remote.candidateType}/${remote.protocol}/${remote.ip || ''}:${remote.port || ''}` : summary.candidatePair.remote;
            }
            entry.lastStats = summary;
            entry.lastStatsAt = Date.now();
            this.voiceTrace('rtc-stats', summary);
        } catch (error) {
            this.voiceTrace('rtc-stats-error', { peer: name, error: error?.message || String(error) }, 'WARN');
        }
    }

    ensureVoiceAudioContext() {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        if (!this.voice.audioContext) {
            this.voice.audioContext = new AudioCtx();
        }
        return this.voice.audioContext;
    }

    ensureVoiceMeterLoop() {
        if (this.voice.meterRaf) return;
        const tick = async () => {
            if (!this.voice.roomId && !this.voice.localStream && this.voice.peerConnections.size === 0) {
                this.voice.meterRaf = 0;
                return;
            }
            if (document.hidden) {
                this.voice.meterRaf = setTimeout(tick, 1000);
                return;
            }
            try {
                await this.updateVoiceMeters();
            } catch (error) {
                this.voiceTrace('meter-update-error', { error: error?.message || String(error) }, 'WARN');
            }
            this.voice.meterRaf = setTimeout(tick, 125);
        };
        this.voice.meterRaf = setTimeout(tick, 0);
    }

    stopVoiceMeterLoop() {
        if (this.voice.meterRaf) {
            clearTimeout(this.voice.meterRaf);
            this.voice.meterRaf = 0;
        }
    }

    computeAnalyserLevel(analyser) {
        if (!analyser) return 0;
        const bufferLength = analyser.fftSize;
        const data = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) {
            const normalized = (value - 128) / 128;
            sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / data.length);
        return Math.max(0, Math.min(1, rms * 2.8));
    }

    ensureMeterEntry(key, stream) {
        const ctx = this.ensureVoiceAudioContext();
        if (!ctx || !stream) return null;
        if (key === 'local') {
            const currentId = stream.id || '';
            if (!this.voice.meterLocal || this.voice.meterLocal.streamId !== currentId) {
                try {
                    if (this.voice.meterLocal?.source) this.voice.meterLocal.source.disconnect?.();
                    if (this.voice.meterLocal?.analyser) this.voice.meterLocal.analyser.disconnect?.();
                } catch (e) {}
                const source = ctx.createMediaStreamSource(stream);
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 512;
                analyser.smoothingTimeConstant = 0.8;
                source.connect(analyser);
                this.voice.meterLocal = {
                    streamId: currentId,
                    source,
                    analyser,
                    data: new Uint8Array(analyser.fftSize),
                };
                this.voiceTrace('meter-local-ready', { streamId: currentId, tracks: stream.getTracks().length });
            }
            return this.voice.meterLocal;
        }

        const peer = String(key || '').trim();
        if (!peer) return null;
        const currentId = stream.id || '';
        const existing = this.voice.meterRemote.get(peer);
        if (!existing || existing.streamId !== currentId) {
            try {
                if (existing?.source) existing.source.disconnect?.();
                if (existing?.analyser) existing.analyser.disconnect?.();
            } catch (e) {}
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.8;
            source.connect(analyser);
            const next = {
                streamId: currentId,
                source,
                analyser,
                data: new Uint8Array(analyser.fftSize),
            };
            this.voice.meterRemote.set(peer, next);
            this.voiceTrace('meter-remote-ready', { peer, streamId: currentId, tracks: stream.getTracks().length });
            return next;
        }
        return existing;
    }

    ensureRemotePlaybackNode(peer, stream) {
        const ctx = this.ensureVoiceAudioContext();
        const name = String(peer || '').trim();
        if (!ctx || !name || !stream) return null;
        const currentId = stream.id || '';
        const existing = this.voice.remotePlaybackNodes?.get(name);
        if (existing && existing.streamId === currentId) return existing;
        try {
            if (existing?.source) existing.source.disconnect?.();
            if (existing?.splitter) existing.splitter.disconnect?.();
            if (existing?.gain) existing.gain.disconnect?.();
        } catch (e) {}
        try {
            const source = ctx.createMediaStreamSource(stream);
            const splitter = ctx.createGain();
            const gain = ctx.createGain();
            splitter.gain.value = 1;
            gain.gain.value = 1;
            source.connect(splitter);
            source.connect(gain);
            splitter.connect(ctx.destination);
            const next = {
                streamId: currentId,
                source,
                splitter,
                gain,
            };
            this.voice.remotePlaybackNodes.set(name, next);
            this.voiceTrace('remote-webaudio-ready', {
                peer: name,
                streamId: currentId,
                contextState: ctx.state || '',
                tracks: stream.getTracks().map(t => `${t.kind}:${t.readyState}:${t.enabled ? 'on' : 'off'}`),
            }, 'SUCCESS');
            return next;
        } catch (error) {
            this.voiceTrace('remote-webaudio-error', { peer: name, error: error?.message || String(error) }, 'ERROR');
            return null;
        }
    }

    updateVoiceMeterDom(kind, percent) {
        const fill = document.getElementById(kind === 'local' ? 'voiceMicLevelFill' : 'voiceServerLevelFill');
        const text = document.getElementById(kind === 'local' ? 'voiceMicLevelText' : 'voiceServerLevelText');
        const row = document.getElementById(kind === 'local' ? 'voiceMicMeter' : 'voiceServerMeter');
        const next = Math.max(0, Math.min(100, Math.round(percent || 0)));
        if (fill) {
            fill.style.width = `${next}%`;
        }
        if (text) {
            text.textContent = `${next}%`;
        }
        if (row) {
            row.dataset.level = String(next);
        }
    }

    async updateVoiceMeters() {
        const localMeter = this.voice.localStream ? this.ensureMeterEntry('local', this.voice.localStream) : null;
        const remoteStreams = [];
        for (const [peer, audio] of this.voice.remoteAudios.entries()) {
            const stream = audio?.srcObject;
            if (stream instanceof MediaStream) {
                remoteStreams.push({ peer, stream });
            }
        }
        const remoteMeters = remoteStreams
            .map(({ peer, stream }) => ({ peer, meter: this.ensureMeterEntry(peer, stream) }))
            .filter(item => item.meter);

        let localLevel = 0;
        if (localMeter?.analyser) {
            localLevel = this.computeAnalyserLevel(localMeter.analyser);
        }

        let remoteLevel = 0;
        for (const item of remoteMeters) {
            const level = this.computeAnalyserLevel(item.meter.analyser);
            remoteLevel = Math.max(remoteLevel, level);
        }

        const nextLocal = Math.round(localLevel * 100);
        const nextRemote = Math.round(remoteLevel * 100);
        const changed = nextLocal !== this.voice.meterLevels.local || nextRemote !== this.voice.meterLevels.remote;
        this.voice.meterLevels = { local: nextLocal, remote: nextRemote };
        if (changed || !this.voice.meterUiRenderedOnce) {
            this.updateVoiceMeterDom('local', nextLocal);
            this.updateVoiceMeterDom('remote', nextRemote);
            this.voice.meterUiRenderedOnce = true;
        }
    }

    async attachLocalVoiceTracks(peer) {
        const entry = this.getVoicePeerEntry(peer);
        if (!entry || !this.voice.localStream || entry.localTracksAttached) return;
        const tracks = this.voice.localStream.getTracks();
        this.voiceTrace('attach-local-tracks', { peer, tracks: tracks.length, roomId: this.voice.roomId || '' });
        const audioTracks = this.voice.localStream.getAudioTracks();
        if (entry.audioSender && audioTracks.length) {
            const track = audioTracks[0];
            try {
                if (entry.audioSender.track !== track) {
                    await entry.audioSender.replaceTrack(track);
                }
                if (typeof entry.audioSender.setStreams === 'function') {
                    try {
                        entry.audioSender.setStreams(this.voice.localStream);
                    } catch (setStreamsError) {
                        this.voiceTrace('set-streams-error', { peer, error: setStreamsError?.message || String(setStreamsError) }, 'WARN');
                    }
                }
                this.voiceTrace('attach-local-sender', {
                    peer,
                    track: `${track.kind}:${track.readyState}:${track.enabled ? 'on' : 'off'}`,
                    senderTrack: entry.audioSender.track ? `${entry.audioSender.track.kind}:${entry.audioSender.track.readyState}:${entry.audioSender.track.enabled ? 'on' : 'off'}` : 'none',
                });
            } catch (error) {
                this.voiceTrace('attach-local-sender-error', { peer, error: error?.message || String(error) }, 'WARN');
            }
        } else {
            for (const track of tracks) {
                const sender = entry.pc.addTrack(track, this.voice.localStream);
                entry.audioSender = sender;
                this.voiceTrace('attach-local-track-added', {
                    peer,
                    track: `${track.kind}:${track.readyState}:${track.enabled ? 'on' : 'off'}`,
                    senderTrack: sender?.track ? `${sender.track.kind}:${sender.track.readyState}:${sender.track.enabled ? 'on' : 'off'}` : 'none',
                });
            }
        }
        entry.localTracksAttached = true;
        this.ensureMeterEntry('local', this.voice.localStream);
        this.ensureVoiceMeterLoop();
    }

    attachRemoteVoiceStream(peer, stream) {
        const name = String(peer || '').trim();
        if (!name || !stream) return;
        let audio = this.voice.remoteAudios.get(name);
        if (!audio) {
            audio = document.createElement('audio');
            audio.autoplay = true;
            audio.playsInline = true;
            audio.hidden = true;
            audio.preload = 'auto';
            audio.muted = true;
            audio.defaultMuted = true;
            audio.volume = 0;
            audio.dataset.peer = name;
            audio.addEventListener('play', () => this.voiceTrace('remote-audio-play', { peer: name, muted: audio.muted, volume: audio.volume }, 'INFO'));
            audio.addEventListener('playing', () => this.voiceTrace('remote-audio-playing', { peer: name, muted: audio.muted, volume: audio.volume }, 'SUCCESS'));
            audio.addEventListener('pause', () => this.voiceTrace('remote-audio-pause', { peer: name }, 'WARN'));
            audio.addEventListener('ended', () => this.voiceTrace('remote-audio-ended', { peer: name }, 'WARN'));
            audio.addEventListener('error', () => this.voiceTrace('remote-audio-error', { peer: name, error: audio.error?.message || audio.error?.code || 'unknown' }, 'ERROR'));
            document.body.appendChild(audio);
            this.voice.remoteAudios.set(name, audio);
        }
        audio.srcObject = stream;
        this.ensureMeterEntry(name, stream);
        this.ensureRemotePlaybackNode(name, stream);
        this.ensureVoiceMeterLoop();
        this.voiceTrace('remote-audio-attach', {
            peer: name,
            streamId: stream.id || '',
            tracks: stream.getTracks().map(t => `${t.kind}:${t.readyState}:${t.enabled ? 'on' : 'off'}`),
            readyState: audio.readyState,
            paused: audio.paused,
            muted: audio.muted,
        });
        const attemptPlay = () => audio.play?.().catch(error => this.voiceTrace('remote-audio-play-failed', { peer: name, error: error?.message || String(error) }, 'WARN'));
        attemptPlay();
        requestAnimationFrame(() => attemptPlay());
        setTimeout(attemptPlay, 250);
    }

    closeVoicePeer(peer) {
        const name = String(peer || '').trim();
        if (!name) return;
        const entry = this.voice.peerConnections.get(name);
        if (entry) {
            this.voiceTrace('peer-close', { peer: name, roomId: this.voice.roomId || '' });
            if (entry.reconnectTimer) {
                clearTimeout(entry.reconnectTimer);
                entry.reconnectTimer = null;
            }
            if (entry.healthTimer) {
                clearTimeout(entry.healthTimer);
                entry.healthTimer = null;
            }
            if (entry.statsTimer) {
                clearInterval(entry.statsTimer);
                entry.statsTimer = null;
            }
            entry.audioSender = null;
            try { entry.pc.close(); } catch (e) {}
            this.voice.peerConnections.delete(name);
        }
        const audio = this.voice.remoteAudios.get(name);
        if (audio) {
            try {
                audio.pause?.();
                audio.srcObject = null;
                audio.remove?.();
            } catch (e) {}
            this.voice.remoteAudios.delete(name);
        }
        const playbackNode = this.voice.remotePlaybackNodes?.get(name);
        if (playbackNode) {
            try { playbackNode.source?.disconnect?.(); } catch (e) {}
            try { playbackNode.splitter?.disconnect?.(); } catch (e) {}
            try { playbackNode.gain?.disconnect?.(); } catch (e) {}
            this.voice.remotePlaybackNodes.delete(name);
        }
        if (this.voice.meterRemote.has(name)) {
            const meter = this.voice.meterRemote.get(name);
            try {
                meter?.source?.disconnect?.();
                meter?.analyser?.disconnect?.();
            } catch (e) {}
            this.voice.meterRemote.delete(name);
        }
        this.voice.meterLevels.remote = 0;
    }

    async sendVoiceOffer(peer) {
        const entry = this.getVoicePeerEntry(peer);
        if (!entry || !this.voice.localStream) return;
        if (entry.offerSent) return;
        this.voiceTrace('send-offer', { peer, roomId: this.voice.roomId || '', roomType: this.voice.roomType || '' });
        await this.attachLocalVoiceTracks(peer);
        const offer = await entry.pc.createOffer();
        await entry.pc.setLocalDescription(offer);
        entry.offerSent = true;
        this.voiceTrace('offer-created', {
            peer,
            roomId: this.voice.roomId || '',
            sdpType: entry.pc.localDescription?.type || 'offer',
            sdpLength: entry.pc.localDescription?.sdp?.length || 0,
        });
        this.sendVoiceEvent({
            type: 'voice_signal',
            roomId: this.voice.roomId,
            roomType: this.voice.roomType,
            serverId: this.voice.serverId,
            channelId: this.voice.channelId,
            to: peer,
            signal: {
                type: 'offer',
                sdp: {
                    type: entry.pc.localDescription?.type || 'offer',
                    sdp: entry.pc.localDescription?.sdp || '',
                },
            },
        });
    }

    async restartVoicePeer(peer) {
        const name = String(peer || '').trim();
        if (!name || !this.voice.roomId) return;
        const entry = this.getVoicePeerEntry(name);
        if (!entry || !this.voice.localStream) return;
        if (entry.healthTimer) {
            clearTimeout(entry.healthTimer);
            entry.healthTimer = null;
        }
        this.voiceTrace('restart-offer', { peer: name, roomId: this.voice.roomId || '' });
        await this.attachLocalVoiceTracks(name);
        const offer = await entry.pc.createOffer({ iceRestart: true });
        await entry.pc.setLocalDescription(offer);
        entry.offerSent = true;
        this.voiceTrace('offer-restart-created', {
            peer: name,
            roomId: this.voice.roomId || '',
            sdpType: entry.pc.localDescription?.type || 'offer',
            sdpLength: entry.pc.localDescription?.sdp?.length || 0,
        });
        this.sendVoiceEvent({
            type: 'voice_signal',
            roomId: this.voice.roomId,
            roomType: this.voice.roomType,
            serverId: this.voice.serverId,
            channelId: this.voice.channelId,
            to: name,
            signal: {
                type: 'offer',
                sdp: {
                    type: entry.pc.localDescription?.type || 'offer',
                    sdp: entry.pc.localDescription?.sdp || '',
                },
            },
        });
    }

    async syncVoicePeers() {
        const participants = Array.isArray(this.voice.participants) ? this.voice.participants : [];
        const peers = participants
            .map(name => String(name || '').trim())
            .filter(Boolean)
            .filter(name => name !== this.myName());
        const nextPeers = new Set(peers);
        this.voiceTrace('sync-peers', {
            roomId: this.voice.roomId || '',
            roomType: this.voice.roomType || '',
            status: this.voice.status || '',
            me: this.myName(),
            peers,
            localStream: !!this.voice.localStream,
        });

        for (const peer of this.voice.peerConnections.keys()) {
            if (!nextPeers.has(peer)) {
                this.closeVoicePeer(peer);
            }
        }

        for (const peer of peers) {
            const entry = this.getVoicePeerEntry(peer);
            await this.attachLocalVoiceTracks(peer);
            if (this.shouldInitiateVoiceOffer(peer) && this.voice.localStream && !entry.offerSent) {
                try {
                    await this.sendVoiceOffer(peer);
                } catch (e) {
                    this.addLogEntry({ type: 'ERROR', msg: `Не удалось начать голосовой обмен с ${peer}`, ts: new Date().toLocaleTimeString() });
                }
            }
        }
        this.renderVoicePanel();
    }

    async joinVoiceChannel({ serverId = null, channelId = null } = {}) {
        const server = this.currentServer();
        const channel = server && channelId ? (server.channels || []).find(ch => ch.id === channelId) : this.currentChannel();
        const sid = String(serverId || server?.id || '').trim();
        const cid = String(channelId || channel?.id || '').trim();
        if (!sid || !cid) return;
        if (!this.isVoiceChannel(channel)) {
            return;
        }
        const roomId = this.voiceRoomKeyForChannel(sid, cid);
        this.voice.roomId = roomId;
        this.voice.roomType = 'channel';
        this.voice.serverId = sid;
        this.voice.channelId = cid;
        this.voice.status = 'connecting';
        this.voice.participants = [];
        this.sendVoiceEvent({
            type: 'voice_join',
            roomId,
            roomType: 'channel',
            serverId: sid,
            channelId: cid,
        });
        this.renderVoicePanel();
    }

    async leaveVoiceRoom({ announce = true, outcome = 'completed' } = {}) {
        const roomId = String(this.voice.roomId || '').trim();
        this.voiceTrace('leave-room', {
            roomId,
            roomType: this.voice.roomType || '',
            announce,
            outcome,
            participants: Array.isArray(this.voice.participants) ? this.voice.participants : [],
        });
        if (this.voice.roomType === 'dm' && roomId && this.voice.callTrack && !this.voice.callTrack.recorded) {
            this.recordVoiceCallHistory({ outcome, endedAt: Date.now() });
        }
        if (announce && roomId) {
            this.sendVoiceEvent({
                type: 'voice_leave',
                roomId,
                roomType: this.voice.roomType,
                serverId: this.voice.serverId,
                channelId: this.voice.channelId,
            });
        }
        this.resetVoiceState();
    }

    async startDirectCall(peer) {
        const target = String(peer || '').trim();
        if (!target) return;
        const me = String(this.myName() || '').trim();
        const roomId = this.makeDmCallRoomId(target);
        if (!roomId) return;
        this.voiceTrace('start-dm-call', { target, me, roomId });
        await this.unlockVoicePlayback();
        this.voice.callTrack = {
            roomId,
            peer: target,
            roomType: 'dm',
            direction: 'outgoing',
            startedAt: Date.now(),
            connectedAt: 0,
            endedAt: 0,
            outcome: 'calling',
            recorded: false,
        };
        this.voice.outgoingInvite = {
            roomId,
            target,
        };
        this.voice.roomId = roomId;
        this.voice.roomType = 'dm';
        this.voice.targetUser = target;
        this.voice.inviter = me;
        this.voice.participants = [me, target].filter(Boolean);
        this.voice.status = 'calling';
        this.sendVoiceEvent({
            type: 'voice_call_invite',
            roomId,
            roomType: 'dm',
            target,
        });
        this.renderVoicePanel();
        try {
            await this.ensureVoiceLocalStream();
            await this.syncVoicePeers();
        } catch (error) {
            this.addLogEntry({
                type: 'WARN',
                msg: error?.message || 'Не удалось подготовить микрофон для звонка',
                ts: new Date().toLocaleTimeString(),
            });
        }
    }

    async acceptIncomingCall() {
        const invite = this.voice.incomingInvite;
        if (!invite?.roomId || !invite?.from) return;
        const me = String(this.myName() || '').trim();
        this.voiceTrace('accept-incoming', { roomId: invite.roomId, from: invite.from, me });
        await this.unlockVoicePlayback();
        this.voice.roomId = String(invite.roomId || '').trim();
        this.voice.roomType = 'dm';
        this.voice.targetUser = String(invite.from || '').trim();
        this.voice.inviter = String(invite.from || '').trim();
        this.voice.participants = [me, String(invite.from || '').trim()].filter(Boolean);
        this.voice.status = 'connecting';
        this.voice.callTrack = {
            roomId: invite.roomId,
            peer: invite.from,
            roomType: 'dm',
            direction: 'incoming',
            startedAt: Date.now(),
            connectedAt: 0,
            endedAt: 0,
            outcome: 'connecting',
            recorded: false,
        };
        this.addLogEntry({
            type: 'INFO',
            msg: `Принимаем звонок ${this.voice.roomId} от ${invite.from}`,
            ts: new Date().toLocaleTimeString(),
        });
        this.renderVoicePanel();
        this.sendVoiceEvent({
            type: 'voice_call_accept',
            roomId: invite.roomId,
            inviter: invite.from,
        });
        this.renderVoicePanel();
        try {
            await this.ensureVoiceLocalStream();
            await this.syncVoicePeers();
        } catch (error) {
            this.addLogEntry({
                type: 'WARN',
                msg: error?.message || 'Не удалось подготовить микрофон для ответа на звонок',
                ts: new Date().toLocaleTimeString(),
            });
        }
    }

    async rejectIncomingCall() {
        const invite = this.voice.incomingInvite;
        if (!invite?.roomId || !invite?.from) return;
        this.voiceTrace('reject-incoming', { roomId: invite.roomId, from: invite.from });
        this.sendVoiceEvent({
            type: 'voice_call_reject',
            roomId: invite.roomId,
            inviter: invite.from,
        });
        this.recordVoiceCallHistory({ outcome: 'rejected', endedAt: Date.now() });
        this.resetVoiceState({ preserveInvite: false });
    }

    toggleVoiceMute() {
        const stream = this.voice.localStream;
        if (!stream) return;
        const nextMuted = !this.voice.muted;
        for (const track of stream.getAudioTracks()) {
            track.enabled = !nextMuted;
        }
        this.voice.muted = nextMuted;
        this.renderVoicePanel();
    }

    recordVoiceCallHistory({ outcome = 'completed', endedAt = Date.now() } = {}) {
        const call = this.voice.callTrack;
        if (!call || call.recorded || call.roomType === 'channel') return;
        const peer = String(call.peer || this.voice.targetUser || this.voice.inviter || '').trim();
        if (!peer) return;
        const direction = String(call.direction || '').trim() || 'outgoing';
        const startMs = Number(call.connectedAt || call.startedAt || endedAt) || endedAt;
        const endMs = Number(endedAt || Date.now()) || Date.now();
        const durationMs = Math.max(0, endMs - startMs);
        const message = {
            id: `call-${call.roomId || peer}-${endMs}`,
            kind: 'call',
            sender: direction === 'outgoing' ? this.myName() : peer,
            receiver: direction === 'outgoing' ? peer : this.myName(),
            text: '',
            attachments: [],
            timestamp: new Date(endMs).toISOString(),
            call: {
                roomId: call.roomId || '',
                peer,
                direction,
                outcome,
                startedAt: new Date(startMs).toISOString(),
                connectedAt: call.connectedAt ? new Date(call.connectedAt).toISOString() : '',
                endedAt: new Date(endMs).toISOString(),
                durationMs,
            },
        };
        const convo = peer;
        this.initChat(convo);
        const arr = this.S.chats[convo];
        const key = this.messageRenderKey(message);
        const exists = arr.some(m => this.messageRenderKey(m) === key);
        if (!exists) {
            arr.push(message);
            arr.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
        }
        call.recorded = true;
        this.voice.callTrack = null;
        this.renderContacts();
        if (this.S.navMode === 'dm' && this.S.current === convo) {
            this.scheduleRenderMessages();
        }
    }

    async handleVoiceSignal(signal = {}) {
        const roomId = String(signal.roomId || '').trim();
        const from = String(signal.from || signal.sender || '').trim();
        const signalPayload = signal.signal || signal.payload || signal;
        if (!roomId || !from || !signalPayload) return;
        this.voiceTrace('signal-recv', {
            roomId,
            from,
            to: signal.to || '',
            signalType: signalPayload.type || '',
            roomType: signal.roomType || this.voice.roomType || '',
        });

        if (signalPayload.type === 'offer') {
            this.voice.roomId = roomId;
            this.voice.roomType = signal.roomType || this.voice.roomType || 'dm';
            this.voice.serverId = signal.serverId || this.voice.serverId || '';
            this.voice.channelId = signal.channelId || this.voice.channelId || '';
            this.voice.targetUser = signal.target || this.voice.targetUser || '';
            this.voice.inviter = signal.from || this.voice.inviter || '';
            this.voice.status = 'connecting';
            const entry = this.getVoicePeerEntry(from);
            try {
                await this.ensureVoiceLocalStream();
            } catch (error) {
                this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось получить доступ к микрофону', ts: new Date().toLocaleTimeString() });
            }
            await this.attachLocalVoiceTracks(from);
            this.voiceTrace('signal-offer-apply', { roomId, from, localStream: !!this.voice.localStream, peer: from });
            await entry.pc.setRemoteDescription(signalPayload.sdp);
            await this.flushPendingVoiceIceCandidates(entry, from);
            const answer = await entry.pc.createAnswer();
            await entry.pc.setLocalDescription(answer);
            this.voiceTrace('signal-answer-send', {
                roomId,
                from,
                peer: from,
                localDesc: entry.pc.localDescription?.type || 'answer',
                sdpLength: entry.pc.localDescription?.sdp?.length || 0,
            });
            this.sendVoiceEvent({
                type: 'voice_signal',
                roomId,
                roomType: this.voice.roomType,
                serverId: this.voice.serverId,
                channelId: this.voice.channelId,
                to: from,
                signal: {
                    type: 'answer',
                    sdp: {
                        type: entry.pc.localDescription?.type || 'answer',
                        sdp: entry.pc.localDescription?.sdp || '',
                    },
                },
            });
            this.voice.participants = Array.from(new Set([this.myName(), from].concat(this.voice.participants || [])));
            this.renderVoicePanel();
            return;
        }

        const entry = this.getVoicePeerEntry(from);
        if (signalPayload.type === 'answer') {
            this.voiceTrace('signal-answer-apply', {
                roomId,
                from,
                peer: from,
                remoteDesc: !!signalPayload.sdp,
                sdpType: signalPayload.sdp?.type || '',
                sdpLength: signalPayload.sdp?.sdp?.length || 0,
            });
            await entry.pc.setRemoteDescription(signalPayload.sdp);
            await this.flushPendingVoiceIceCandidates(entry, from);
            this.voice.status = 'connected';
            this.renderVoicePanel();
            return;
        }

        if (signalPayload.type === 'ice' && signalPayload.candidate) {
            try {
                entry.receivedIceCandidates = (entry.receivedIceCandidates || 0) + 1;
                const candidateInfo = this.describeIceCandidate(signalPayload.candidate.candidate || '');
                this.voiceTrace('signal-ice-recv', {
                    roomId,
                    from,
                    peer: from,
                    count: entry.receivedIceCandidates,
                    candidateType: candidateInfo.type,
                    protocol: candidateInfo.protocol,
                    address: candidateInfo.address,
                });
                if (entry.pc.remoteDescription) {
                    this.voiceTrace('signal-ice-apply', { roomId, from, peer: from, queued: false });
                    await entry.pc.addIceCandidate(signalPayload.candidate);
                } else {
                    entry.pendingIceCandidates = entry.pendingIceCandidates || [];
                    entry.pendingIceCandidates.push(signalPayload.candidate);
                    this.voiceTrace('signal-ice-queue', { roomId, from, peer: from, queued: true, queueSize: entry.pendingIceCandidates.length });
                }
            } catch (e) {
                console.warn('Failed to add ICE candidate', e);
                this.voiceTrace('signal-ice-error', { roomId, from, peer: from, error: e?.message || String(e) }, 'WARN');
            }
        }
    }

    async handleVoiceEvent(payload = {}) {
        const eventType = String(payload?.type || '').trim();
        if (!eventType) return;
        this.voiceTrace('event-recv', {
            eventType,
            roomId: payload.roomId || '',
            roomType: payload.roomType || '',
            from: payload.from || '',
            target: payload.target || '',
        });

        if (eventType === 'voice_call_invite') {
            const from = String(payload.from || '').trim();
            const roomId = String(payload.roomId || '').trim();
            // Busy guard: an invite used to overwrite voice state unconditionally —
            // an incoming call from a third user mid-call clobbered callTrack /
            // incomingInvite and flipped the UI to "входящий звонок", killing the
            // active call's state (the RTCPeerConnections kept running headless).
            // Auto-reject instead; the server allows the target of a ringing room
            // to reject it, so the caller gets a normal voice_call_rejected.
            const activeRoomId = String(this.voice.roomId || '').trim();
            const busy = activeRoomId && activeRoomId !== roomId && this.isInActiveCall();
            if (busy) {
                this.voiceTrace('incoming-invite-busy', { roomId, from, activeRoomId, status: this.voice.status }, 'WARN');
                this.sendVoiceEvent({
                    type: 'voice_call_reject',
                    roomId,
                    inviter: from,
                });
                this.addLogEntry({ type: 'INFO', msg: `Входящий звонок от ${from} отклонён: уже идёт другой звонок`, ts: new Date().toLocaleTimeString() });
                return;
            }
            this.voice.incomingInvite = {
                roomId,
                from,
                roomType: 'dm',
            };
            this.voice.inviter = from;
            this.voice.callTrack = {
                roomId,
                peer: from,
                roomType: 'dm',
                direction: 'incoming',
                startedAt: Date.now(),
                connectedAt: 0,
                endedAt: 0,
                outcome: 'incoming',
                recorded: false,
            };
            this.voice.outgoingInvite = null;
            this.voice.status = 'incoming';
            this.voiceTrace('incoming-invite', { roomId, from });
            this.renderVoicePanel();
            return;
        }

        if (eventType === 'voice_call_outgoing') {
            this.voice.outgoingInvite = {
                roomId: String(payload.roomId || '').trim(),
                target: String(payload.target || '').trim(),
            };
            this.voice.targetUser = String(payload.target || '').trim();
            this.voice.status = 'calling';
            this.voiceTrace('outgoing-ring', { roomId: this.voice.outgoingInvite.roomId, target: this.voice.targetUser });
            this.renderVoicePanel();
            return;
        }

        if (eventType === 'voice_signal') {
            this.voiceTrace('signal-event', {
                roomId: payload.roomId || '',
                from: payload.from || payload.sender || '',
                to: payload.to || '',
                signalType: payload.signal?.type || payload.payload?.type || '',
            });
            await this.handleVoiceSignal(payload);
            return;
        }

        if (eventType === 'voice_call_rejected') {
            if (this.voice.outgoingInvite?.roomId === String(payload.roomId || '').trim()) {
                this.voiceTrace('outgoing-rejected', { roomId: payload.roomId || '', from: payload.from || '' }, 'WARN');
                this.recordVoiceCallHistory({ outcome: 'rejected', endedAt: Date.now() });
                this.resetVoiceState({ preserveInvite: false });
            }
            return;
        }

        if (eventType === 'voice_call_cancelled') {
            if (this.voice.incomingInvite?.roomId === String(payload.roomId || '').trim()) {
                this.voiceTrace('incoming-cancelled', { roomId: payload.roomId || '', from: payload.from || '' }, 'WARN');
                this.recordVoiceCallHistory({ outcome: 'cancelled', endedAt: Date.now() });
                this.resetVoiceState({ preserveInvite: false });
            }
            return;
        }

        if (eventType === 'voice_call_missed') {
            const roomId = String(payload.roomId || '').trim();
            if (this.voice.incomingInvite?.roomId === roomId || this.voice.outgoingInvite?.roomId === roomId) {
                this.voiceTrace('call-missed', { roomId, from: payload.from || '', target: payload.target || '' }, 'WARN');
                this.recordVoiceCallHistory({ outcome: 'missed', endedAt: Date.now() });
                this.resetVoiceState({ preserveInvite: false });
            }
            return;
        }

        if (eventType === 'voice_call_accepted') {
            const roomId = String(payload.roomId || '').trim();
            const me = String(this.myName() || '').trim();
            const from = String(payload.from || '').trim();
            const target = String(payload.target || '').trim();
            const remotePeer = from && from !== me ? from : target;
            const callOwner = target || this.voice.inviter || '';
            const participants = Array.isArray(payload.participants)
                ? payload.participants.map(name => String(name || '').trim()).filter(Boolean)
                : [payload.from, payload.target].map(name => String(name || '').trim()).filter(Boolean);
            this.voice.roomId = roomId || this.voice.roomId;
            this.voice.roomType = 'dm';
            this.voice.targetUser = remotePeer || this.voice.targetUser || '';
            this.voice.inviter = callOwner || this.voice.inviter || '';
            this.voice.participants = participants.length ? participants : this.voice.participants;
            this.voice.status = 'connected';
            if (roomId && String(this.voice.outgoingInvite?.roomId || '').trim() === roomId) {
                this.voice.outgoingInvite = null;
            }
            if (roomId && String(this.voice.incomingInvite?.roomId || '').trim() === roomId) {
                this.voice.incomingInvite = null;
            }
            this.voiceTrace('call-accepted', { roomId, from, target, participants });
            if (this.voice.callTrack) {
                this.voice.callTrack.connectedAt = this.voice.callTrack.connectedAt || Date.now();
                this.voice.callTrack.outcome = 'connected';
            }
            this.renderVoicePanel();
            try {
                await this.ensureVoiceLocalStream();
            } catch (error) {
                this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось получить доступ к микрофону', ts: new Date().toLocaleTimeString() });
            }
            await this.syncVoicePeers();
            return;
        }

        if (eventType === 'voice_call_connected') {
            const roomId = String(payload.roomId || '').trim();
            const me = String(this.myName() || '').trim();
            const from = String(payload.from || '').trim();
            const target = String(payload.target || '').trim();
            const remotePeer = from && from !== me ? from : target;
            const callOwner = target || this.voice.inviter || '';
            const participants = Array.isArray(payload.participants)
                ? payload.participants.map(name => String(name || '').trim()).filter(Boolean)
                : [payload.from, payload.target].map(name => String(name || '').trim()).filter(Boolean);
            this.voice.roomId = roomId || this.voice.roomId;
            this.voice.roomType = 'dm';
            this.voice.targetUser = remotePeer || this.voice.targetUser || '';
            this.voice.inviter = callOwner || this.voice.inviter || '';
            this.voice.participants = participants.length ? participants : this.voice.participants;
            this.voice.status = 'connected';
            if (roomId && String(this.voice.outgoingInvite?.roomId || '').trim() === roomId) {
                this.voice.outgoingInvite = null;
            }
            if (roomId && String(this.voice.incomingInvite?.roomId || '').trim() === roomId) {
                this.voice.incomingInvite = null;
            }
            this.voiceTrace('call-connected', { roomId, from, target, participants }, 'SUCCESS');
            if (this.voice.callTrack) {
                this.voice.callTrack.connectedAt = this.voice.callTrack.connectedAt || Date.now();
                this.voice.callTrack.outcome = 'connected';
            }
            this.renderVoicePanel();
            try {
                await this.ensureVoiceLocalStream();
            } catch (error) {
                this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось получить доступ к микрофону', ts: new Date().toLocaleTimeString() });
            }
            await this.syncVoicePeers();
            return;
        }

        if (eventType === 'voice_error') {
            this.addLogEntry({
                type: 'ERROR',
                msg: String(payload.message || 'Ошибка voice'),
                ts: new Date().toLocaleTimeString(),
            });
            return;
        }

        if (eventType === 'voice_room_state') {
            const roomId = String(payload.roomId || '').trim();
            const roomStatus = String(payload.status || '').trim().toLowerCase();
            const roomInitiator = String(payload.initiator || '').trim();
            const roomTarget = String(payload.target || '').trim();
            const participants = Array.isArray(payload.participants) ? payload.participants.map(name => String(name || '').trim()).filter(Boolean) : [];
            const currentRoomId = String(this.voice.roomId || '').trim();
            // Foreign-room guard for ANY active call, not just dm→dm: a user sitting in
            // a channel voice room is made a participant of a new ringing DM room the
            // moment someone invites them, so the broadcastVoiceRoomState for that new
            // room arrives here and used to overwrite roomId/participants/status of the
            // channel session. Only room states for the room we are actually in may
            // mutate live call state while a call is in progress.
            const inActiveCall = this.isInActiveCall();
            if (currentRoomId && roomId && roomId !== currentRoomId && (this.voice.roomType === 'dm' || inActiveCall)) {
                this.voiceTrace('room-state-stale', { roomId, currentRoomId }, 'INFO');
                return;
            }
            this.voice.roomId = roomId;
            this.voice.roomType = String(payload.roomType || this.voice.roomType || '').trim();
            this.voice.serverId = String(payload.serverId || this.voice.serverId || '').trim();
            this.voice.channelId = String(payload.channelId || this.voice.channelId || '').trim();
            this.voice.participants = participants;
            const me = String(this.myName() || '').trim();
            const amParticipant = participants.includes(me);
            if (roomStatus === 'ringing' || roomStatus === 'pending') {
                if (me && roomTarget && me === roomTarget) {
                    this.voice.incomingInvite = {
                        roomId,
                        from: roomInitiator || this.voice.inviter || '',
                        roomType: 'dm',
                    };
                    this.voice.inviter = roomInitiator || this.voice.inviter || '';
                    this.voice.targetUser = roomTarget || this.voice.targetUser || '';
                    this.voice.callTrack = this.voice.callTrack || {
                        roomId,
                        peer: roomInitiator || roomTarget || '',
                        roomType: 'dm',
                        direction: 'incoming',
                        startedAt: Date.now(),
                        connectedAt: 0,
                        endedAt: 0,
                        outcome: 'incoming',
                        recorded: false,
                    };
                    this.voice.status = 'incoming';
                } else if (me && roomInitiator && me === roomInitiator) {
                    this.voice.outgoingInvite = {
                        roomId,
                        target: roomTarget || this.voice.targetUser || '',
                    };
                    this.voice.targetUser = roomTarget || this.voice.targetUser || '';
                    this.voice.inviter = roomInitiator || this.voice.inviter || '';
                    this.voice.callTrack = this.voice.callTrack || {
                        roomId,
                        peer: roomTarget || roomInitiator || '',
                        roomType: 'dm',
                        direction: 'outgoing',
                        startedAt: Date.now(),
                        connectedAt: 0,
                        endedAt: 0,
                        outcome: 'calling',
                        recorded: false,
                    };
                    this.voice.status = 'calling';
                } else {
                    this.voice.status = amParticipant ? 'connecting' : 'idle';
                }
            } else {
                this.voice.status = amParticipant ? 'connected' : 'idle';
            }
            this.voiceTrace('room-state', { roomId, roomType: this.voice.roomType || '', participants });
            if (amParticipant && this.voice.callTrack && !this.voice.callTrack.connectedAt && roomStatus !== 'ringing' && roomStatus !== 'pending') {
                this.voice.callTrack.connectedAt = Date.now();
                this.voice.callTrack.outcome = 'connected';
            }
            if (roomStatus === 'missed') {
                if (this.voice.callTrack && !this.voice.callTrack.connectedAt) {
                    this.voice.callTrack.connectedAt = Date.now();
                    this.voice.callTrack.outcome = 'missed';
                }
                if (this.voice.incomingInvite?.roomId === roomId || this.voice.outgoingInvite?.roomId === roomId) {
                    this.recordVoiceCallHistory({ outcome: 'missed', endedAt: Date.now() });
                    this.resetVoiceState({ preserveInvite: false });
                }
                return;
            }
            if (roomStatus !== 'ringing' && roomStatus !== 'pending') {
                if (String(this.voice.outgoingInvite?.roomId || '').trim() === roomId) {
                    this.voice.outgoingInvite = null;
                }
                if (String(this.voice.incomingInvite?.roomId || '').trim() === roomId) {
                    this.voice.incomingInvite = null;
                }
            }
            if (amParticipant && roomStatus !== 'ringing' && roomStatus !== 'pending') {
                try {
                    await this.ensureVoiceLocalStream();
                } catch (error) {
                    this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось получить доступ к микрофону', ts: new Date().toLocaleTimeString() });
                }
                await this.syncVoicePeers();
            } else if (roomStatus === 'ringing' || roomStatus === 'pending') {
                this.renderVoicePanel();
            } else if (this.voice.roomType === 'dm' && this.voice.roomId === roomId && this.voice.callTrack) {
                this.voice.status = this.voice.status === 'idle' ? 'connecting' : this.voice.status;
            } else {
                this.voiceTrace('room-state-reset', { roomId, participants }, 'WARN');
                this.resetVoiceState({ preserveInvite: true });
            }
            this.renderVoicePanel();
            return;
        }

        if (eventType === 'voice_call_ended') {
            const roomId = String(payload.roomId || '').trim();
            const currentRoomId = String(this.voice.roomId || '').trim();
            if (roomId && currentRoomId && roomId !== currentRoomId) {
                this.voiceTrace('call-ended-stale', { roomId, currentRoomId }, 'INFO');
                return;
            }
            this.voiceTrace('call-ended', { roomId, from: payload.from || '', currentRoomId });
            this.leaveVoiceRoom({ announce: false, outcome: 'completed' });
            return;
        }
    }

    renderVoiceParticipants() {
        const participants = Array.isArray(this.voice.participants) ? this.voice.participants : [];
        if (!participants.length) {
            return '<div class="voice-empty">Пока никого нет</div>';
        }
        return `<div class="voice-participants">` + participants.map(name => {
            const cls = name === this.myName() ? 'mine' : '';
            return `<span class="voice-participant ${cls}">${this.esc(name)}</span>`;
        }).join('') + `</div>`;
    }

    renderVoiceRoomView() {
        const isVoice = this.isVoiceChannel(this.currentChannel());
        const me = String(this.myName() || '').trim().toLowerCase();
        const participants = Array.isArray(this.voice.participants)
            ? this.voice.participants.map(name => String(name || '').trim().toLowerCase()).filter(Boolean)
            : [];
        const participantMatch = me && participants.includes(me);
        // The server lists both sides as room "participants" the moment an invite is
        // created (voice.rs voice_call_invite handler), well before anyone accepts —
        // it models "who belongs to this ringing room", not "who is actually on the
        // call". Treating participantMatch alone as "active call" made the callee's
        // panel render as an already-connected call (only Завершить/mute, no
        // Принять/Отклонить) the instant the invite arrived, so the call could never
        // actually be accepted and the server's 60s ringing timeout later marked it
        // missed. Ringing/calling states must render as pending, not active.
        const pendingDmCall = this.voice.status === 'incoming' || this.voice.status === 'calling';
        const connectedDmRoom = this.voice.roomType === 'dm' && !!String(this.voice.roomId || '').trim() && !pendingDmCall && (this.voice.status === 'connected' || participantMatch);
        const activeRoom = isVoice ? !!this.voice.roomId && participantMatch : connectedDmRoom;
        const outgoingTarget = this.voice.outgoingInvite?.target || this.voice.targetUser || '';
        const incomingFrom = this.voice.incomingInvite?.from || this.voice.inviter || '';
        const voiceHealth = this.getVoiceHealthSnapshot();
        const title = isVoice
            ? `Голосовой канал: ${this.currentChannel()?.name || 'room'}`
            : activeRoom
                ? `Активный звонок${outgoingTarget || incomingFrom ? ` с ${outgoingTarget || incomingFrom}` : ''}`
                : this.voice.status === 'incoming'
                    ? `Входящий звонок от ${incomingFrom}`
                    : this.voice.status === 'calling'
                        ? `Звонок ${outgoingTarget ? `к ${outgoingTarget}` : ''}`
                        : this.voice.status === 'connecting'
                            ? `Соединяемся${outgoingTarget || incomingFrom ? ` с ${outgoingTarget || incomingFrom}` : ''}`
                            : 'Голосовые вызовы';

        const actionButtons = [];
        if (isVoice) {
            if (activeRoom) {
                actionButtons.push(`<button class="voice-btn danger" type="button" id="voiceLeaveBtn">Покинуть</button>`);
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceMuteBtn">${this.voice.muted ? 'Включить микрофон' : 'Выключить микрофон'}</button>`);
            } else {
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceJoinBtn">Присоединиться</button>`);
            }
        } else if (this.S.navMode === 'dm' && this.S.current) {
            if (activeRoom) {
                actionButtons.push(`<button class="voice-btn danger" type="button" id="voiceLeaveBtn">Завершить</button>`);
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceMuteBtn">${this.voice.muted ? 'Включить микрофон' : 'Выключить микрофон'}</button>`);
            } else if (this.voice.status === 'incoming' && this.voice.incomingInvite?.from) {
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceAcceptBtn">Принять</button>`);
                actionButtons.push(`<button class="voice-btn danger" type="button" id="voiceRejectBtn">Отклонить</button>`);
            } else if (this.voice.status === 'calling') {
                actionButtons.push(`<button class="voice-btn danger" type="button" id="voiceCancelBtn">Отменить</button>`);
            } else {
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceCallBtn">Позвонить</button>`);
            }
        }

        return `
            <div class="voice-room-card ${activeRoom ? 'active' : ''} ${isVoice ? 'voice-channel' : ''}">
                <div class="voice-room-top">
                    <div>
                        <div class="voice-room-title">${this.esc(title)}</div>
                        <div class="voice-room-sub">${this.esc(this.voice.status === 'connected' ? 'Собеседник поднял трубку' : this.voice.status === 'incoming' ? 'Входящий звонок' : this.voice.status === 'calling' ? 'Ожидание ответа' : this.voice.status === 'connecting' ? 'Соединяемся' : 'Голос готов')}</div>
                    </div>
                    <div class="voice-room-state">${this.esc(activeRoom ? 'В эфире' : isVoice ? 'Выбрано' : 'Ожидание')}</div>
                </div>
                <div class="voice-room-actions">${actionButtons.join('')}</div>
                <div class="voice-meter-grid">
                    <div class="voice-meter" id="voiceMicMeter">
                        <div class="voice-meter-head">
                            <span class="voice-meter-name">Микрофон</span>
                            <span class="voice-meter-value" id="voiceMicLevelText">0%</span>
                        </div>
                        <div class="voice-meter-track">
                            <div class="voice-meter-fill" id="voiceMicLevelFill"></div>
                        </div>
                    </div>
                    <div class="voice-meter" id="voiceServerMeter">
                        <div class="voice-meter-head">
                            <span class="voice-meter-name">С сервера</span>
                            <span class="voice-meter-value" id="voiceServerLevelText">0%</span>
                        </div>
                        <div class="voice-meter-track">
                            <div class="voice-meter-fill remote" id="voiceServerLevelFill"></div>
                        </div>
                    </div>
                </div>
                ${voiceHealth.length ? `
                    <div class="voice-health">
                        <div class="voice-room-label">Voice health</div>
                        <div class="voice-health-grid">
                            ${voiceHealth.map(item => `
                                <div class="voice-health-card" data-tone="${this.esc(item.tone)}">
                                    <span class="voice-health-name">${this.esc(item.label)}</span>
                                    <strong class="voice-health-value">${this.esc(item.value)}</strong>
                                    <span class="voice-health-sub">${this.esc(item.sub || '')}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
                <div class="voice-room-participants">
                    <div class="voice-room-label">Участники</div>
                    ${this.renderVoiceParticipants()}
                </div>
                ${Array.isArray(this.voice.traceLines) && this.voice.traceLines.length ? `
                    <div class="voice-trace">
                        <div class="voice-room-label">Трассировка</div>
                        <div class="voice-trace-list">
                            ${this.voice.traceLines.slice(-8).map(line => `
                                <div class="voice-trace-line voice-trace-${this.esc(line.level.toLowerCase())}">
                                    <span class="voice-trace-ts">[${this.esc(line.ts)}]</span>
                                    <span class="voice-trace-stage">${this.esc(line.stage)}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    // Coalesces bursts of voice-panel refreshes (ICE candidate storms, rapid state
    // flips) into one render per window instead of one innerHTML rebuild per event.
    scheduleRenderVoicePanel(delayMs = 100) {
        if (this._voicePanelRenderTimer) return;
        this._voicePanelRenderTimer = setTimeout(() => {
            this._voicePanelRenderTimer = null;
            this.renderVoicePanel();
        }, Math.max(0, Number(delayMs) || 0));
    }

    renderVoicePanel() {
        const panel = document.getElementById('voicePanel');
        if (!panel) return;
        const isServers = this.S.navMode === 'servers';
        const isVoiceChannel = isServers && this.isVoiceChannel(this.currentChannel());
        const hasDmCall = this.voice.roomType === 'dm' || this.voice.status === 'incoming' || this.voice.status === 'calling';
        const hasIncoming = this.voice.status === 'incoming';
        const showPanel = isVoiceChannel || hasDmCall || hasIncoming;
        panel.hidden = !showPanel;
        if (!showPanel) {
            panel.innerHTML = '';
            return;
        }
        if (isVoiceChannel || hasDmCall || hasIncoming || this.voice.roomType === 'dm') {
            panel.innerHTML = this.renderVoiceRoomView();
            return;
        }
        panel.innerHTML = '';
    }

    isOutgoingMessage(msg) {
        return String(msg?.sender || '').trim() === this.myName();
    }

    mergeServerChatMessages(key, incomingMessages) {
        const existing = Array.isArray(this.S.serverChats[key]) ? this.S.serverChats[key] : [];
        const merged = [];
        const mergedByKey = new Map();

        const makeIdentity = (msg) => {
            const normalized = {
                ...msg,
                id: String(msg?.id || '').trim(),
                clientId: String(msg?.clientId || '').trim(),
                serverId: msg?.serverId || msg?.server_id || null,
                channelId: msg?.channelId || msg?.channel_id || null,
            };
            const attachmentKey = this.normalizeAttachments(normalized.attachments)
                .map(att => `${att.name}:${att.kind}:${att.size}:${att.mimeType}`)
                .join('|');
            const identity = normalized.id || normalized.clientId || [
                normalized.sender || '',
                normalized.receiver || '',
                normalized.timestamp || '',
                normalized.text || '',
                attachmentKey,
            ].join('::');
            return { normalized, identity };
        };

        // Snapshot which identities were already known BEFORE this merge, so any
        // incoming message that lands under a brand new identity can be told apart
        // from a status/metadata update to something we already had.
        const existingIdentities = new Set(existing.map(msg => makeIdentity(msg).identity));
        const newlyInserted = [];

        const upsert = (msg, { fromIncoming = false } = {}) => {
            const { normalized, identity } = makeIdentity(msg);
            const prev = mergedByKey.get(identity);
            const next = prev
                ? {
                    ...prev,
                    ...normalized,
                    attachments: this.normalizeAttachments(normalized.attachments ?? prev.attachments),
                    reactions: this.normalizeReactions(normalized.reactions ?? prev.reactions),
                    myReaction: String(normalized.myReaction ?? prev.myReaction ?? '').trim(),
                }
                : {
                    ...normalized,
                    attachments: this.normalizeAttachments(normalized.attachments),
                    reactions: this.normalizeReactions(normalized.reactions),
                    myReaction: String(normalized.myReaction || '').trim(),
                };
            mergedByKey.set(identity, next);
            if (!prev) merged.push(identity);
            if (fromIncoming && !existingIdentities.has(identity)) {
                newlyInserted.push(next);
            }
        };

        existing.forEach(msg => upsert(msg));
        (Array.isArray(incomingMessages) ? incomingMessages : []).forEach(msg => upsert(msg, { fromIncoming: true }));

        const next = merged
            .map(identity => mergedByKey.get(identity))
            .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
        this.S.serverChats[key] = next;
        this.saveStoredServerChats();

        // First time this channel is ever merged in this session (initial history
        // load / first open), just prime the baseline silently — otherwise opening a
        // channel with months of history would replay it all as notifications. Only
        // merges AFTER that baseline (reconnect catch-up, background refreshes)
        // notify for genuinely new messages, same rule as loadHistory() for DMs.
        const alreadyPrimed = this._historyPrimedChannels.has(key);
        if (!alreadyPrimed) {
            this._historyPrimedChannels.add(key);
        } else if (newlyInserted.length && !this.isServerChatVisible(key)) {
            newlyInserted.forEach(msg => {
                this.notifyBackgroundMessage({
                    sender: msg.sender,
                    text: msg.text,
                    attachmentCount: this.normalizeAttachments(msg.attachments).length,
                    serverId: msg.serverId,
                    channelId: msg.channelId,
                });
            });
            this.renderServerInterface();
            this.renderContacts();
        }
        return next;
    }

    ensureServerSelection() {
        this.ensureServersState();
        const servers = Array.isArray(this.S.servers) ? this.S.servers : [];
        if (servers.length === 0) {
            this.S.activeServer = null;
            this.S.activeChannel = null;
            this.S.activeConversationType = 'dm';
            return;
        }

        const storedServer = this.loadStoredActiveServer();
        if (storedServer && servers.some(s => s.id === storedServer)) {
            this.S.activeServer = storedServer;
        } else if (!this.S.activeServer || !servers.some(s => s.id === this.S.activeServer)) {
            this.S.activeServer = servers[0].id;
        }

        const server = this.currentServer();
        const storedChannel = this.loadStoredActiveChannel();
        if (server) {
            if (storedChannel && (server.channels || []).some(ch => ch.id === storedChannel)) {
                this.S.activeChannel = storedChannel;
            } else if (!this.S.activeChannel || !(server.channels || []).some(ch => ch.id === this.S.activeChannel)) {
                this.S.activeChannel = server.channels?.[0]?.id || null;
            }
        }
    }

    async loadServers({ silent = false } = {}) {
        try {
            if (!this.S.session?.token) {
                this.S.servers = [];
                this.ensureServerSelection();
                this.renderContacts();
                this.renderServerInterface();
                this.scheduleRenderMessages();
                return;
            }
            const res = await this.apiFetch(this.apiRoutes.servers.list);
            if (!res.ok) {
                this.S.servers = [];
                this.ensureServerSelection();
                this.renderContacts();
                this.renderServerInterface();
                this.scheduleRenderMessages();
                return;
            }
            const data = await res.json();
            this.S.servers = this.normalizeServers(Array.isArray(data?.servers) ? data.servers : []);
            this.ensureServerSelection();
            this.renderContacts();
            this.renderServerInterface();
            this.scheduleRenderMessages();
            if (this.S.activeServer && this.S.activeChannel) {
                this.loadServerMessages(this.S.activeServer, this.S.activeChannel, { silent: true });
            }
        } catch (e) {
            if (!silent) {
                this.addLogEntry({ type: 'WARN', msg: 'Не удалось загрузить серверы', ts: new Date().toLocaleTimeString() });
            }
            this.S.servers = [];
            this.ensureServerSelection();
            this.renderContacts();
            this.renderServerInterface();
            this.scheduleRenderMessages();
            if (this.S.activeServer && this.S.activeChannel) {
                this.loadServerMessages(this.S.activeServer, this.S.activeChannel, { silent: true });
            }
        }
    }

    async loadServerMessages(serverId, channelId, { silent = false } = {}) {
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        if (!sid || !cid) return;
        this.trace(`loadServerMessages start server=${sid} channel=${cid} nativeHistory=${this.nativeSupports('serverHistory')}`);
        if (!this.S.session?.token) {
            this.scheduleRenderMessages();
            return;
        }
        const key = `${sid}:${cid}`;
        if (!Array.isArray(this.S.serverChats[key])) {
            this.S.serverChats[key] = [];
        }
        const channel = (this.currentServer()?.channels || []).find(item => item.id === cid) || null;
        if (this.isVoiceChannel(channel)) {
            this.scheduleRenderMessages();
            return;
        }
        this.scheduleRenderMessages();

        if (this.nativeSupports('serverHistory')) {
            const conversationKey = this.ensureConversationCryptoKey({
                serverId: sid,
                channelId: cid,
                reason: 'loadServerMessages',
            });
            this.postNativeMessage({
                type: NativeMessageTypes.LOAD_SERVER_HISTORY,
                serverId: sid,
                channelId: cid,
                key: conversationKey,
            });
            return;
        }

        // No native shell to decrypt channel history for us — each row here is just
        // server-known metadata (id/sender/receiver/filename/timestamp), same as a DM
        // history row. Route it through the same WASM download+unpack path used for
        // live-received messages instead of showing "encrypted, needs native bridge".
        if (!(await this.wasmAvailable())) {
            if (!silent) {
                this.addLogEntry({ type: 'WARN', msg: 'WASM недоступен: сообщения канала не будут расшифрованы', ts: new Date().toLocaleTimeString() });
            }
            return;
        }
        try {
            const limit = 200;
            let offset = 0;
            let mergedCount = 0;
            while (true) {
                const res = await this.apiFetch(this.apiRoutes.servers.channelMessages(sid, cid, limit, offset));
                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    this.trace(`loadServerMessages failed server=${sid} channel=${cid} status=${res.status} offset=${offset} body=${text.slice(0, 300)}`);
                    if (!silent) {
                        this.addLogEntry({ type: 'WARN', msg: `Не удалось загрузить сообщения канала ${cid}`, ts: new Date().toLocaleTimeString() });
                    }
                    return;
                }
                const messages = await res.json();
                const batch = Array.isArray(messages) ? messages : [];
                this.trace(`loadServerMessages success server=${sid} channel=${cid} offset=${offset} count=${batch.length}`);
                for (const msg of batch) {
                    await this.handleIncomingBrowserMessage(msg);
                }
                mergedCount += batch.length;
                if (batch.length < limit) break;
                offset += limit;
            }
            this.trace(`loadServerMessages merged server=${sid} channel=${cid} count=${mergedCount}`);
        } catch (e) {
            if (!silent) {
                this.addLogEntry({ type: 'ERROR', msg: `Ошибка загрузки канала ${cid}: ${e?.message || e}`, ts: new Date().toLocaleTimeString() });
            }
        }
    }

    loadServerHistory(payload) {
        if (!payload || typeof payload !== 'object') return;
        const serverId = String(payload.serverId || payload.server_id || '').trim();
        const channelId = String(payload.channelId || payload.channel_id || '').trim();
        const messages = Array.isArray(payload.messages) ? payload.messages : [];
        if (!serverId || !channelId) return;
        const queue = messages.filter(msg => msg && typeof msg === 'object');
        this.trace(`loadServerHistory start server=${serverId} channel=${channelId} count=${queue.length}`);
        const key = `${serverId}:${channelId}`;
        const reconciled = [];
        const processBatch = (startIndex = 0) => {
            const startedAt = performance.now();
            let index = startIndex;
            for (; index < queue.length; index += 1) {
                if ((index - startIndex) >= 120) break;
                if ((performance.now() - startedAt) >= 8) break;
                const raw = queue[index];
                const msg = {
                    ...raw,
                    serverId: raw.serverId || raw.server_id || serverId,
                    channelId: raw.channelId || raw.channel_id || channelId,
                };
                const normalizedAttachments = this.normalizeAttachments(msg.attachments);
                const normalizedReactions = this.normalizeReactions(msg.reactions);
                const msgId = String(msg.id || '').trim();
                const clientId = String(msg.clientId || msg.client_id || '').trim();
                if (clientId && this.finalizePendingMessage(clientId, msg.id, { render: false })) {
                    this.dropPendingOutbox(clientId);
                    continue;
                }
                const incomingKey = this.messageRenderKey(msg);
                const existingIndex = msgId
                    ? reconciled.findIndex(m => String(m.id || '').trim() === msgId)
                    : reconciled.findIndex(m => this.messageRenderKey(m) === incomingKey);
                if (existingIndex >= 0) {
                    const prev = reconciled[existingIndex];
                    reconciled[existingIndex] = {
                        ...prev,
                        ...msg,
                        id: msgId || msg.id || prev.id || '',
                        attachments: normalizedAttachments.length ? normalizedAttachments : this.normalizeAttachments(prev.attachments),
                        reactions: normalizedReactions.length ? normalizedReactions : this.normalizeReactions(prev.reactions),
                        myReaction: msg.myReaction || prev.myReaction || '',
                        text: this.sanitizeDecryptionErrorText(msg.text) || prev.text || '',
                        status: 'sent',
                        serverId: msg.serverId || msg.server_id || serverId,
                        channelId: msg.channelId || msg.channel_id || channelId,
                    };
                } else {
                    reconciled.push({
                        ...msg,
                        id: msgId || msg.id || '',
                        attachments: normalizedAttachments,
                        reactions: normalizedReactions,
                        myReaction: msg.myReaction || '',
                        text: this.sanitizeDecryptionErrorText(msg.text),
                        status: 'sent',
                    });
                }
            }
            if (index < queue.length) {
                requestAnimationFrame(() => processBatch(index));
                return;
            }
            this.mergeServerChatMessages(key, reconciled);
            if (this.currentServerChatKey() === key) {
                this.scheduleRenderMessages();
            }
            this.scheduleFlushPendingOutbox(300);
            this.trace(`loadServerHistory done server=${serverId} channel=${channelId} merged=${reconciled.length}`);
        };
        processBatch(0);
    }

    async refreshAfterKey() {
        if (this._refreshAfterKeyInFlight) {
            this._refreshAfterKeyQueued = true;
            return;
        }
        this._refreshAfterKeyInFlight = true;
        try {
            await this._refreshAfterKeyImpl();
        } finally {
            this._refreshAfterKeyInFlight = false;
            if (this._refreshAfterKeyQueued) {
                this._refreshAfterKeyQueued = false;
                void this.refreshAfterKey();
            }
        }
    }

    async _refreshAfterKeyImpl() {
        if (!this.S.session?.token) {
            this.scheduleFlushPendingOutbox(300);
            return;
        }
        // Pull newly published key envelopes (e.g. after a key_envelope_available
        // WS notification) so a stale self-generated key can be replaced before we
        // resolve and re-decrypt the active conversation. triggerRefresh=false
        // avoids re-entering this method.
        await this.syncIncomingKeyEnvelopes({ reason: 'refreshAfterKey', triggerRefresh: false });
        if (this.S.navMode === 'servers') {
            this.ensureServerSelection();
        } else if (!this.S.current) {
            const storedCurrent = this.loadStoredCurrentContact();
            if (storedCurrent) {
                this.S.current = storedCurrent;
                this.ensureContact(storedCurrent);
                this.initChat(storedCurrent);
            }
        }

        if (this.S.navMode === 'servers' && this.S.activeServer && this.S.activeChannel) {
            const key = await this.resolveConversationCryptoKey({
                serverId: this.S.activeServer,
                channelId: this.S.activeChannel,
                reason: 'refreshAfterKey'
            });
            this.loadServerMessages(this.S.activeServer, this.S.activeChannel, { silent: true });
            this.scheduleFlushPendingOutbox(300);
            return;
        }

        if (this.S.current) {
            const key = await this.resolveConversationCryptoKey({ peer: this.S.current, reason: 'refreshAfterKey' });
            if (this.nativeSupports('sendMessage')) {
                this.postNativeMessage({ type: NativeMessageTypes.REFRESH_HISTORY, key, peer: this.S.current });
            } else {
                void this.loadBrowserDmHistory(this.S.current, key);
            }
        }
        this.scheduleFlushPendingOutbox(300);
    }

    async syncActiveConversation({ force = false } = {}) {
        if (!this.S.session?.token) return;
        if (!force && document.hidden) return;
        if (this.S.navMode === 'servers') {
            const serverId = this.S.activeServer;
            const channelId = this.S.activeChannel;
            if (serverId && channelId) {
                const syncKey = `server:${serverId}:${channelId}`;
                const now = Date.now();
                const lastSyncAt = this.conversationSyncAt.get(syncKey) || 0;
                if (!force && (now - lastSyncAt) < 30000) return;
                this.conversationSyncAt.set(syncKey, now);
                this.trace(`syncActiveConversation server=${serverId} channel=${channelId}`);
                await this.resolveConversationCryptoKey({
                    serverId,
                    channelId,
                    reason: 'syncActiveConversation',
                });
                this.loadServerMessages(serverId, channelId, { silent: true });
            }
            return;
        }

        const peer = String(this.S.current || '').trim();
        if (!peer) return;
        const syncKey = `dm:${peer}`;
        const now = Date.now();
        const lastSyncAt = this.conversationSyncAt.get(syncKey) || 0;
        if (!force && (now - lastSyncAt) < 60000) return;
        this.conversationSyncAt.set(syncKey, now);
        this.trace(`syncActiveConversation peer=${peer} force=${force}`);
        const key = await this.resolveConversationCryptoKey({ peer, reason: 'syncActiveConversation' });
        if (this.nativeSupports('sendMessage')) {
            this.postNativeMessage({ type: NativeMessageTypes.REFRESH_HISTORY, key, peer });
        } else {
            void this.loadBrowserDmHistory(peer, key);
        }
    }

    async syncConversationFromNative(payload = {}) {
        if (!this.S.session?.token) return;
        const serverId = String(payload?.serverId || '').trim();
        const channelId = String(payload?.channelId || '').trim();
        const peer = String(payload?.peer || '').trim();
        if (serverId && channelId) {
            await this.resolveConversationCryptoKey({ serverId, channelId, reason: 'syncConversationFromNative' });
            this.loadServerMessages(serverId, channelId, { silent: true });
            return;
        }
        if (peer) {
            const key = await this.resolveConversationCryptoKey({ peer, reason: 'syncConversationFromNative' });
            if (this.nativeSupports('sendMessage')) {
                this.postNativeMessage({ type: NativeMessageTypes.REFRESH_HISTORY, key, peer });
            }
            return;
        }
        this.syncActiveConversation({ force: !!payload?.force });
    }

    scheduleConversationRefresh({ peer = null, serverId = null, channelId = null, reason = 'message', delayMs = 250 } = {}) {
        if (!this.S.session?.token) return;
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        const dmPeer = String(peer || '').trim();
        const key = sid && cid
            ? `server:${sid}:${cid}`
            : dmPeer
                ? `dm:${dmPeer}`
                : '';
        if (!key) return;

        if (this.conversationRefreshTimers.has(key)) {
            clearTimeout(this.conversationRefreshTimers.get(key));
        }

        this.conversationRefreshTimers.set(key, setTimeout(() => {
            this.conversationRefreshTimers.delete(key);
            if (sid && cid) {
                this.trace(`scheduleConversationRefresh fire reason=${reason} server=${sid} channel=${cid}`);
                this.resolveConversationCryptoKey({
                    serverId: sid,
                    channelId: cid,
                    reason: `refresh:${reason}`,
                });
                this.loadServerMessages(sid, cid, { silent: true });
                return;
            }

            if (!dmPeer) return;
            this.trace(`scheduleConversationRefresh fire reason=${reason} peer=${dmPeer}`);
            this.resolveConversationCryptoKey({ peer: dmPeer, reason: `refresh:${reason}` }).then((keyValue) => {
                if (this.nativeSupports('sendMessage')) {
                    this.postNativeMessage({ type: NativeMessageTypes.REFRESH_HISTORY, key: keyValue, peer: dmPeer });
                }
            });
        }, Math.max(100, Number(delayMs) || 250)));
    }

    renderServerInterface() {
        this.ensureServersState();
        this.ensureServerSelection();
        this.renderServerToolbar();
        this.updateSendButtonState();
    }

    renderServerToolbar() {
        const channelList = document.getElementById('serverChannelList');
        const chatHdr = document.getElementById('chatHdr');
        const chatHdrAva = document.getElementById('chatHdrAva');
        const chatHdrName = document.getElementById('chatHdrName');
        const chatHdrSub = document.getElementById('chatHdrSub');
        const chatCallBtn = document.getElementById('chatCallBtn');
        const serverSettingsBtn = document.getElementById('serverSettingsBtn');
        const tbChat = document.getElementById('tbChat');
        const server = this.currentServer();
        const channel = this.currentChannel();
        const isServers = this.S.navMode === 'servers';
        const canManage = this.canManageServer(server);

        if (chatHdr) chatHdr.classList.toggle('server-mode', isServers);
        if (channelList) channelList.hidden = !isServers;
        if (chatCallBtn) {
            chatCallBtn.hidden = isServers || !this.S.current;
        }
        if (serverSettingsBtn) {
            serverSettingsBtn.hidden = !isServers || !server || !canManage;
            serverSettingsBtn.disabled = !canManage;
        }
        if (!isServers) {
            if (channelList) channelList.innerHTML = '';
            if (chatHdrAva) chatHdrAva.innerHTML = this.renderAvatarHTML(this.S.current || this.myName(), 'avatar-img', this.S.current || this.myName());
            if (chatHdrName) chatHdrName.textContent = this.S.current || 'Выберите чат';
            if (tbChat) tbChat.textContent = this.S.current || (this.S.contacts.length ? 'Выберите чат' : 'Нет контактов');
            if (chatHdrSub) {
                chatHdrSub.innerHTML = '';
                if (this.S.current) {
                    this.updateChatHeaderCryptoKey({ peer: this.S.current });
                } else {
                    chatHdrSub.textContent = 'Личное сообщение';
                }
            }
            return;
        }
        if (!server) {
            if (channelList) channelList.innerHTML = '';
            return;
        }

        if (chatHdrAva) chatHdrAva.innerHTML = this.esc(server.icon || server.name?.[0] || 'S');
        if (chatHdrName) {
            const membersText = Number(server.memberCount || 0) > 0 ? `${Number(server.memberCount)} участников` : '';
            const channelTitle = channel
                ? `${this.channelKindIcon(channel.kind, 'chat-hdr-channel-icon')}<span>${this.esc(channel.name)}</span>`
                : this.esc(server.name);
            chatHdrName.innerHTML = `
                <span class="chat-hdr-title">${channelTitle}</span>
                ${membersText ? `<span class="chat-hdr-count">${this.esc(membersText)}</span>` : ''}
            `;
        }
        if (chatHdrSub) {
            chatHdrSub.textContent = channel
                ? `${server.name}${channel.topic ? ` · ${channel.topic}` : ''}`
                : (server.description || 'Сервер');
        }
        if (tbChat) {
            tbChat.textContent = channel
                ? `${server.name} / ${this.channelKindLabel(channel.kind)}: ${channel.name}`
                : server.name;
        }

        if (channelList) {
            const channels = Array.isArray(server.channels) ? server.channels : [];
            channelList.innerHTML = channels.map(ch => {
            const active = ch.id === this.S.activeChannel ? 'active' : '';
            const kind = String(ch.kind || 'text').trim().toLowerCase();
            const title = kind === 'voice' ? 'Голосовой канал' : 'Текстовый канал';
            const chKey = `${server.id}:${ch.id}`;
            const cnt = kind === 'voice' ? 0 : Number(this.S.channelUnread?.[chKey] || 0);
            const badge = cnt > 0 ? `<span class="badge">${cnt > 99 ? '99+' : cnt}</span>` : '';
            const muted = kind !== 'voice' && this.isChannelMuted(server.id, ch.id);
            const muteToggle = kind === 'voice' ? '' : `<button class="channel-mute-toggle${muted ? ' muted' : ''}" type="button" data-toggle-mute-channel="${this.esc(server.id)}:${this.esc(ch.id)}" title="${muted ? 'Включить уведомления' : 'Отключить уведомления'}" aria-label="${muted ? 'Включить уведомления' : 'Отключить уведомления'}">${muted ? '🔕' : '🔔'}</button>`;
            // A <div> (not <button>) — it hosts a nested mute-toggle <button>, and
            // <button> cannot contain another <button> (the HTML parser would
            // implicitly close the outer one). Click delegation on data-channel-id
            // above already doesn't care about the tag, so this is a drop-in swap.
            return `<div class="server-channel ${active}" data-channel-id="${this.esc(ch.id)}" data-channel-kind="${this.esc(kind)}" title="${this.esc(title)}">
                    <span class="server-channel-hash ${kind}">${this.channelKindIcon(kind, 'server-channel-list-icon')}</span>
                    <span class="server-channel-name">${this.esc(ch.name)}</span>
                    ${muteToggle}
                    ${badge}
                </div>`;
        }).join('');

            const activeChannel = channelList.querySelector('.server-channel.active');
            if (activeChannel && typeof activeChannel.scrollIntoView === 'function') {
                requestAnimationFrame(() => {
                    activeChannel.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                });
            }
        }
    }

    setActiveChannel(channelId, { persist = true } = {}) {
        const next = String(channelId || '').trim();
        const server = this.currentServer();
        if (!server || !next) return;
        const channel = (server.channels || []).find(ch => ch.id === next) || null;
        if (!channel) return;
        if (this.S.navMode === 'servers' && this.S.activeChannel === next) return;
        if (this.voice.roomType === 'channel' && this.voice.roomId) {
            const currentChannelId = String(this.voice.channelId || '').trim();
            if (currentChannelId && currentChannelId !== next) {
                this.leaveVoiceRoom({ announce: true });
            }
        }
        this.S.activeChannel = next;
        // Selecting the channel makes it visible again — clear whatever unread
        // counter it accrued while it wasn't the active one, mirroring switchChat's
        // S.unread[peer] = 0 for DMs.
        this.S.channelUnread = this.S.channelUnread || {};
        this.S.channelUnread[`${server.id}:${next}`] = 0;
        if (persist) this.saveStoredActiveChannel(next);
        this.saveStoredNavMode('servers');
        this.renderServerToolbar();
        this.requestMessagesScroll('bottom');
        this.scheduleRenderMessages();
        this.updateSendButtonState();
        if (this.isVoiceChannel(channel)) {
            const roomId = this.voiceRoomKeyForChannel(server.id, next);
            const alreadyJoined = this.voice.roomId === roomId && this.voice.participants.includes(this.myName());
            if (!alreadyJoined) {
                this.joinVoiceChannel({ serverId: server.id, channelId: next });
            } else {
                this.renderVoicePanel();
            }
            this.renderVoicePanel();
            return;
        }
        this.requestMessagesScroll('bottom');
        this.loadServerMessages(server.id, next, { silent: true });
        this.closeMobileSidebar();
        this.syncMobileChrome();
    }

    setNavMode(mode, { persist = true, refresh = true } = {}) {
        const next = mode === 'servers' ? 'servers' : 'dm';
        this.S.activeConversationType = next;
        if (next === 'servers') {
            this.ensureServersState();
            this.ensureServerSelection();
        } else {
            this.clearActiveServerSelection({ persist });
        }
        if (this.S.navMode === next) {
            this.updateNavModeButtons();
            if (next === 'dm') {
                this.renderServerInterface();
                this.updateSendButtonState();
            }
            return;
        }
        this.S.navMode = next;
        if (persist) {
            this.saveStoredNavMode(next);
        }
        // Returning to the DM view makes the selected chat visible again — clear the
        // unread counter it may have accrued while the servers view was covering it.
        if (next === 'dm' && this.S.current) {
            this.S.unread[this.S.current] = 0;
        }
        // Mirror for the servers view: the already-selected channel becomes visible
        // again, so clear whatever it accrued while the DM view was covering it.
        if (next === 'servers' && this.S.activeServer && this.S.activeChannel) {
            this.S.channelUnread = this.S.channelUnread || {};
            this.S.channelUnread[`${this.S.activeServer}:${this.S.activeChannel}`] = 0;
        }
        this.updateNavModeButtons();
        if (!refresh) return;
        this.resetMessageWindow();
        this.renderServerInterface();
        this.renderContacts();
        this.requestMessagesScroll('bottom');
        this.scheduleRenderMessages();
        this.renderVoicePanel();
        if (next === 'servers' && this.S.activeServer && this.S.activeChannel) {
            this.requestMessagesScroll('bottom');
            this.loadServerMessages(this.S.activeServer, this.S.activeChannel, { silent: true });
        }
        this.syncMobileChrome();
    }

    avatarCacheKey(username) {
        return String(username || '').trim().toLowerCase();
    }

    loadStoredAvatar(username) {
        const key = this.avatarCacheKey(username);
        return this.avatarCache.has(key) ? this.avatarCache.get(key) : undefined;
    }

    saveStoredAvatar(username, dataUrl) {
        const key = this.avatarCacheKey(username);
        const prev = this.avatarCache.get(key);
        if (prev && typeof prev === 'string' && prev.startsWith('blob:') && prev !== dataUrl) {
            try { URL.revokeObjectURL(prev); } catch (e) {}
        }
        this.avatarFetchSeq.set(key, (this.avatarFetchSeq.get(key) || 0) + 1);
        this.avatarCache.set(key, dataUrl || null);
    }

    clearStoredAvatar(username) {
        const key = this.avatarCacheKey(username);
        const prev = this.avatarCache.get(key);
        if (prev && typeof prev === 'string' && prev.startsWith('blob:')) {
            try { URL.revokeObjectURL(prev); } catch (e) {}
        }
        this.avatarFetchSeq.set(key, (this.avatarFetchSeq.get(key) || 0) + 1);
        this.avatarCache.delete(key);
    }

    avatarFallback(username) {
        const value = String(username || '').trim();
        return value ? value[0].toUpperCase() : 'Z';
    }

    renderAvatarHTML(username, className = 'ava', alt = '') {
        const src = this.loadStoredAvatar(username);
        const fallback = this.avatarFallback(username);
        const safeAlt = this.esc(alt || username || fallback);
        if (src === undefined) {
            this.ensureAvatarLoaded(username);
        } else if (src) {
            const classes = String(className || '')
                .split(/\s+/)
                .filter(Boolean)
                .concat('avatar-img')
                .filter((v, i, arr) => arr.indexOf(v) === i)
                .join(' ');
            return `<img class="${classes}" src="${this.esc(src)}" alt="${safeAlt}">`;
        }
        return `<span class="avatar-fallback">${this.esc(fallback)}</span>`;
    }

    serverAssetCacheKey(serverId, kind) {
        return `${String(serverId || '').trim()}:${kind}`;
    }

    async loadServerAsset(serverId, kind, { force = false } = {}) {
        const sid = String(serverId || '').trim();
        if (!sid) return null;
        const key = this.serverAssetCacheKey(sid, kind);
        if (!force && this.serverAssetCache.has(key)) {
            return this.serverAssetCache.get(key);
        }
        if (this.serverAssetRequests.has(key) && !force) {
            return this.serverAssetRequests.get(key);
        }

        const seq = (this.serverAssetFetchSeq.get(key) || 0) + 1;
        this.serverAssetFetchSeq.set(key, seq);

        const request = (async () => {
            try {
                const res = await this.apiFetch(this.apiRoutes.servers.assets(sid, kind));
                if (this.serverAssetFetchSeq.get(key) !== seq) return null;
                if (res.status === 404) {
                    this.serverAssetCache.set(key, null);
                    return null;
                }
                if (!res.ok) return null;
                const blob = await res.blob();
                if (!blob || blob.size === 0) {
                    this.serverAssetCache.set(key, null);
                    return null;
                }
                const url = await this.blobToObjectUrl(blob);
                this.serverAssetCache.set(key, url);
                return url;
            } catch (e) {
                return null;
            } finally {
                if (this.serverAssetRequests.get(key) === request) {
                    this.serverAssetRequests.delete(key);
                }
            }
        })();

        this.serverAssetRequests.set(key, request);
        return request;
    }

    clearServerAssetCache(serverId, kind) {
        const key = this.serverAssetCacheKey(serverId, kind);
        const prev = this.serverAssetCache.get(key);
        if (prev && typeof prev === 'string' && prev.startsWith('blob:')) {
            try { URL.revokeObjectURL(prev); } catch (e) {}
        }
        this.serverAssetFetchSeq.set(key, (this.serverAssetFetchSeq.get(key) || 0) + 1);
        this.serverAssetCache.delete(key);
    }

    serverAssetFallback(server, kind) {
        if (kind === 'avatar') {
            return this.esc(server?.icon || server?.name?.[0] || 'S');
        }
        return this.esc((server?.name || 'BAN').slice(0, 3).toUpperCase());
    }

    resetServerAssetPreview() {
        const avatarBox = document.getElementById('serverAvatarPreview');
        const bannerBox = document.getElementById('serverBannerPreview');
        if (avatarBox) {
            avatarBox.innerHTML = '';
            avatarBox.style.backgroundImage = '';
            avatarBox.textContent = 'S';
        }
        if (bannerBox) {
            bannerBox.innerHTML = '';
            bannerBox.style.backgroundImage = '';
            bannerBox.style.backgroundSize = '';
            bannerBox.style.backgroundPosition = '';
            bannerBox.textContent = 'BAN';
        }
    }

    async syncServerAssetPreview(serverId) {
        const sid = String(serverId || '').trim();
        const avatar = await this.loadServerAsset(serverId, 'avatar');
        const banner = await this.loadServerAsset(serverId, 'banner');
        const avatarBox = document.getElementById('serverAvatarPreview');
        const bannerBox = document.getElementById('serverBannerPreview');
        const server = (this.S.servers || []).find(item => item.id === sid) || null;
        if (avatarBox) {
            avatarBox.style.backgroundImage = '';
            if (avatar) {
                avatarBox.innerHTML = `<img class="avatar-img" src="${this.esc(avatar)}" alt="server avatar">`;
            } else {
                avatarBox.innerHTML = '';
                avatarBox.textContent = this.serverAssetFallback(server, 'avatar');
            }
        }
        if (bannerBox) {
            if (banner) {
                bannerBox.innerHTML = '';
                bannerBox.style.backgroundImage = `url('${this.esc(banner)}')`;
                bannerBox.style.backgroundSize = 'cover';
                bannerBox.style.backgroundPosition = 'center';
            } else {
                bannerBox.style.backgroundImage = '';
                bannerBox.innerHTML = '';
                bannerBox.textContent = this.serverAssetFallback(server, 'banner');
            }
        }
    }

    scheduleAvatarRefresh() {
        if (this.avatarRefreshScheduled) return;
        this.avatarRefreshScheduled = true;
        requestAnimationFrame(() => {
            this.avatarRefreshScheduled = false;
            this.renderSidebarProfile();
            this.renderContacts();
            // The chat header avatar (own avatar in the empty/DM state, peer avatar in a
            // DM) is rendered by renderServerToolbar; without refreshing it here it keeps
            // the fallback letter it drew before the avatar finished loading async.
            this.renderServerToolbar();
        });
    }

    updateAvatarViews() {
        this.renderSidebarProfile();
        this.renderContacts();
        this.renderServerToolbar();
        this.scheduleRenderMessages();
    }

    refreshVisibleAvatars() {
        if (document.hidden) return;
        if (this.nativeSupports('serverHistory') && this.nativeSupports('voice') && this.nativeSupports('downloadAttachment')) return;
        const users = new Set([this.myName(), this.S.current, ...(this.S.contacts || [])].filter(Boolean));
        document.querySelectorAll('.avatar-img[alt]').forEach(img => {
            const name = String(img.getAttribute('alt') || '').trim();
            if (name) users.add(name);
        });
        users.forEach(username => {
            this.ensureAvatarLoaded(username);
        });
    }

    async blobToObjectUrl(blob) {
        return URL.createObjectURL(blob);
    }

    dataUrlToBlob(dataUrl) {
        const value = String(dataUrl || '').trim();
        if (!value.startsWith('data:')) return null;

        const commaIndex = value.indexOf(',');
        if (commaIndex < 0) return null;

        const meta = value.slice(5, commaIndex);
        const payload = value.slice(commaIndex + 1);
        const parts = meta.split(';').filter(Boolean);
        const mimeType = parts[0] || 'application/octet-stream';
        const isBase64 = parts.includes('base64');

        try {
            if (isBase64) {
                const binary = atob(payload);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i += 1) {
                    bytes[i] = binary.charCodeAt(i);
                }
                return new Blob([bytes], { type: mimeType });
            }

            return new Blob([decodeURIComponent(payload)], { type: mimeType });
        } catch (error) {
            console.error('Failed to decode data URL', error);
            return null;
        }
    }

    async downloadAttachmentFromHref(href, filename) {
        const source = String(href || '').trim();
        const safeName = String(filename || 'attachment').trim() || 'attachment';
        if (!source) return false;

        if (this.nativeSupports('downloadAttachment') && source.startsWith('data:')) {
            this.postNativeMessage({
                type: NativeMessageTypes.DOWNLOAD_ATTACHMENT,
                dataUrl: source,
                filename: safeName,
            });
            return true;
        }

        let objectUrl = source;
        let shouldRevoke = false;

        try {
            if (source.startsWith('data:')) {
                const blob = this.dataUrlToBlob(source);
                if (!blob || blob.size === 0) {
                    throw new Error('Empty attachment payload');
                }
                objectUrl = URL.createObjectURL(blob);
                shouldRevoke = true;
            } else if (!source.startsWith('blob:')) {
                const response = await fetch(source);
                if (!response.ok) {
                    throw new Error(`Unexpected response while downloading attachment: ${response.status}`);
                }
                const blob = await response.blob();
                if (!blob || blob.size === 0) {
                    throw new Error('Empty attachment payload');
                }
                objectUrl = URL.createObjectURL(blob);
                shouldRevoke = true;
            }

            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = safeName;
            link.rel = 'noopener';
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();

            if (shouldRevoke) {
                setTimeout(() => {
                    try { URL.revokeObjectURL(objectUrl); } catch (e) {}
                }, 1000);
            }

            return true;
        } catch (error) {
            console.error('Failed to download attachment', error);
            return false;
        }
    }

    async ensureAvatarLoaded(username, { force = false } = {}) {
        const name = String(username || '').trim();
        if (!name) return null;
        const key = this.avatarCacheKey(name);
        if (!force && this.avatarCache.has(key)) {
            return this.avatarCache.get(key);
        }
        if (this.avatarRequests.has(key)) {
            if (!force) {
                return this.avatarRequests.get(key);
            }
        }

        const seq = (this.avatarFetchSeq.get(key) || 0) + 1;
        this.avatarFetchSeq.set(key, seq);

        const request = (async () => {
            try {
                if (this.nativeSupports('avatarFetch')) {
                    try {
                        const payload = await this.requestNativeAction({
                            type: NativeMessageTypes.LOAD_AVATAR_REQUEST,
                            username: name,
                        });
                        if (this.avatarFetchSeq.get(key) !== seq) {
                            return null;
                        }
                        const dataUrl = String(payload?.data?.dataUrl || '').trim();
                        if (!dataUrl) {
                            this.saveStoredAvatar(name, null);
                            this.scheduleAvatarRefresh();
                            return null;
                        }
                        this.saveStoredAvatar(name, dataUrl);
                        this.scheduleAvatarRefresh();
                        return dataUrl;
                    } catch (nativeError) {
                        this.trace(`ensureAvatarLoaded native failed username=${name} err=${nativeError?.message || nativeError}`);
                    }
                }

                const res = await this.apiFetch(this.apiRoutes.avatar.byUsername(name));
                if (this.avatarFetchSeq.get(key) !== seq) {
                    return null;
                }
                if (res.status === 404) {
                    this.saveStoredAvatar(name, null);
                    this.scheduleAvatarRefresh();
                    return null;
                }
                if (!res.ok) {
                    return null;
                }

                const blob = await res.blob();
                if (this.avatarFetchSeq.get(key) !== seq) {
                    return null;
                }
                if (!blob || blob.size === 0) {
                    this.saveStoredAvatar(name, null);
                    this.scheduleAvatarRefresh();
                    return null;
                }

                const url = await this.blobToObjectUrl(blob);
                if (this.avatarFetchSeq.get(key) !== seq) {
                    try { URL.revokeObjectURL(url); } catch (e) {}
                    return null;
                }
                this.saveStoredAvatar(name, url);
                this.scheduleAvatarRefresh();
                return url;
            } catch (e) {
                return null;
            } finally {
                if (this.avatarRequests.get(key) === request) {
                    this.avatarRequests.delete(key);
                }
            }
        })();

        this.avatarRequests.set(key, request);
        return request;
    }

    renderSidebarProfile() {
        const meName = document.getElementById('meName');
        const meSub = document.getElementById('meSub');
        const meAva = document.getElementById('meAva');
        const avatarPreview = document.getElementById('avatarPreview');
        const username = this.myName();
        if (meName) meName.textContent = username;
        if (meAva) meAva.innerHTML = this.renderAvatarHTML(username, 'avatar-img', username);
        if (avatarPreview) {
            avatarPreview.innerHTML = this.renderAvatarHTML(username, 'avatar-img', username);
            avatarPreview.title = `Ваш аватар: ${username}`;
        }
        this.ensureAvatarLoaded(username);
        if (meSub) {
            meSub.innerHTML = this.S.session?.token
                ? '<span class="online-dot"></span> В сети'
                : '<span class="online-dot guest"></span> Гостевой режим';
        }
        this.updateContactControls();
        this.renderContactSuggestions();
        this.updateNavModeButtons();
        this.ensureServersState();
    }

    readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
            reader.readAsDataURL(file);
        });
    }

    // Re-encode an avatar to a SMALL JPEG before upload, iterating dimension/quality
    // down until the encoded bytes fit a tight budget (~14 KB). Avatars render as tiny
    // circles, so this costs no visible quality — and it is the difference between the
    // avatar loading or not over a low-MTU / lossy path (e.g. a VPN with MTU 1280):
    // there the server's response stalls once it exceeds roughly the TCP initial window
    // (~12–30 KB with MSS 1240), so a 31 KB avatar never finishes downloading while a
    // ~10 KB one arrives in the first round-trip. Best-effort: returns the original file
    // if the canvas pipeline is unavailable.
    async downscaleAvatarFile(file, targetBytes = 14 * 1024) {
        try {
            if (typeof document === 'undefined' || typeof document.createElement !== 'function') return file;
            const dataUrl = await this.readFileAsDataURL(file);
            const img = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error('decode failed'));
                im.src = dataUrl;
            });
            const w = img.naturalWidth || img.width;
            const h = img.naturalHeight || img.height;
            if (!w || !h) return file;
            const baseName = String(file.name || 'avatar').replace(/\.[^.]+$/, '') || 'avatar';
            const encode = async (dim, q) => {
                const scale = Math.min(1, dim / Math.max(w, h));
                const cw = Math.max(1, Math.round(w * scale));
                const ch = Math.max(1, Math.round(h * scale));
                const canvas = document.createElement('canvas');
                canvas.width = cw;
                canvas.height = ch;
                const ctx = canvas.getContext('2d');
                if (!ctx) return null;
                ctx.drawImage(img, 0, 0, cw, ch);
                return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));
            };
            // Progressively smaller/lower-quality until under budget. Ordered largest→smallest
            // so we keep the best quality that still fits.
            const attempts = [[256, 0.8], [224, 0.72], [192, 0.66], [160, 0.62], [128, 0.6], [96, 0.55]];
            let best = null;
            for (const [dim, q] of attempts) {
                const blob = await encode(dim, q);
                if (!blob || blob.size === 0) continue;
                best = blob;
                if (blob.size <= targetBytes) break;
            }
            if (!best || best.size >= file.size) {
                // Couldn't beat the original (already tiny, or encode unavailable).
                if (best && best.size < file.size) {
                    return new File([best], `${baseName}.jpg`, { type: 'image/jpeg' });
                }
                return file;
            }
            this.trace(`downscaleAvatar ${file.size}B -> ${best.size}B`);
            return new File([best], `${baseName}.jpg`, { type: 'image/jpeg' });
        } catch (e) {
            this.trace(`downscaleAvatar failed, using original: ${e?.message || e}`);
            return file;
        }
    }

    // Interactive pan/zoom crop before upload. Without this, a fixed center-square
    // crop can slice straight through whatever the source photo happens to frame at
    // its edges (e.g. a vignette/fisheye shot), producing a circle avatar that reads
    // as "cropped into a strange shape" instead of a clean headshot. Resolves to a
    // square JPEG File, or null if the user cancels.
    openAvatarCropper(file) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('avatarCropOverlay');
            const stage = document.getElementById('avatarCropStage');
            const img = document.getElementById('avatarCropImg');
            const circleGuide = document.getElementById('avatarCropCircleGuide');
            const zoomInput = document.getElementById('avatarCropZoom');
            const saveBtn = document.getElementById('avatarCropSaveBtn');
            const cancelBtn = document.getElementById('avatarCropCancelBtn');
            const closeBtn = document.getElementById('avatarCropCloseBtn');
            if (!overlay || !stage || !img || !circleGuide || !zoomInput || !saveBtn || !cancelBtn || !closeBtn) {
                resolve(null);
                return;
            }

            const objectUrl = URL.createObjectURL(file);
            // left/top position the image relative to the SQUARE stage, but coverage
            // is only required over the circle guide inset within it — the ring
            // between circle and stage edge is deliberately allowed to show
            // (dimmed) whatever part of the photo falls outside the crop.
            const state = { scale: 1, minScale: 1, maxScale: 1, left: 0, top: 0, naturalW: 0, naturalH: 0 };
            const listeners = [];
            const on = (el, type, handler, opts) => {
                el.addEventListener(type, handler, opts);
                listeners.push(() => el.removeEventListener(type, handler, opts));
            };

            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                listeners.forEach(off => off());
                overlay.classList.remove('visible');
                setTimeout(() => { overlay.hidden = true; }, 180);
                URL.revokeObjectURL(objectUrl);
                img.removeAttribute('src');
                resolve(result);
            };

            const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

            const circleBounds = () => {
                const stageSize = stage.clientWidth;
                const circleSize = circleGuide.clientWidth || stageSize;
                const margin = (stageSize - circleSize) / 2;
                return { stageSize, circleSize, margin };
            };

            const applyTransform = () => {
                img.style.width = `${state.naturalW * state.scale}px`;
                img.style.height = `${state.naturalH * state.scale}px`;
                img.style.left = `${state.left}px`;
                img.style.top = `${state.top}px`;
            };

            const clampPosition = () => {
                const { circleSize, margin } = circleBounds();
                const displayedW = state.naturalW * state.scale;
                const displayedH = state.naturalH * state.scale;
                state.left = clamp(state.left, margin + circleSize - displayedW, margin);
                state.top = clamp(state.top, margin + circleSize - displayedH, margin);
            };

            const setScale = (nextScale, focalStageX, focalStageY) => {
                const { stageSize } = circleBounds();
                const fx = focalStageX ?? stageSize / 2;
                const fy = focalStageY ?? stageSize / 2;
                const prevScale = state.scale;
                // Keep the point under the focal coordinate stable while zooming.
                const naturalFocalX = (fx - state.left) / prevScale;
                const naturalFocalY = (fy - state.top) / prevScale;
                state.scale = clamp(nextScale, state.minScale, state.maxScale);
                state.left = fx - naturalFocalX * state.scale;
                state.top = fy - naturalFocalY * state.scale;
                clampPosition();
                applyTransform();
            };

            img.onload = () => {
                // Unhide first — stage/circleGuide report clientWidth 0 while
                // display:none, which would collapse every size computed below.
                overlay.hidden = false;

                state.naturalW = img.naturalWidth || 1;
                state.naturalH = img.naturalHeight || 1;
                const { stageSize, circleSize } = circleBounds();
                state.minScale = circleSize / Math.min(state.naturalW, state.naturalH);
                state.maxScale = state.minScale * 3;
                state.scale = state.minScale;
                state.left = (stageSize - state.naturalW * state.scale) / 2;
                state.top = (stageSize - state.naturalH * state.scale) / 2;
                applyTransform();
                zoomInput.min = '0';
                zoomInput.max = '1000';
                zoomInput.value = '0';

                requestAnimationFrame(() => overlay.classList.add('visible'));
            };
            img.onerror = () => finish(null);
            img.src = objectUrl;

            on(zoomInput, 'input', () => {
                const t = Number(zoomInput.value) / 1000;
                setScale(state.minScale + t * (state.maxScale - state.minScale));
            });

            let dragging = false;
            let dragStartX = 0;
            let dragStartY = 0;
            let dragStartLeft = 0;
            let dragStartTop = 0;

            on(stage, 'pointerdown', (e) => {
                dragging = true;
                stage.classList.add('dragging');
                stage.setPointerCapture?.(e.pointerId);
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                dragStartLeft = state.left;
                dragStartTop = state.top;
            });
            on(stage, 'pointermove', (e) => {
                if (!dragging) return;
                state.left = dragStartLeft + (e.clientX - dragStartX);
                state.top = dragStartTop + (e.clientY - dragStartY);
                clampPosition();
                applyTransform();
            });
            const stopDrag = (e) => {
                dragging = false;
                stage.classList.remove('dragging');
                if (e && stage.releasePointerCapture) {
                    try { stage.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
                }
            };
            on(stage, 'pointerup', stopDrag);
            on(stage, 'pointercancel', stopDrag);
            on(stage, 'wheel', (e) => {
                e.preventDefault();
                const rect = stage.getBoundingClientRect();
                const focalX = e.clientX - rect.left;
                const focalY = e.clientY - rect.top;
                const factor = Math.exp(-e.deltaY * 0.0015);
                setScale(state.scale * factor, focalX, focalY);
                const t = (state.scale - state.minScale) / (state.maxScale - state.minScale || 1);
                zoomInput.value = String(Math.round(clamp(t, 0, 1) * 1000));
            }, { passive: false });

            on(cancelBtn, 'click', () => finish(null));
            on(closeBtn, 'click', () => finish(null));
            on(document, 'keydown', (e) => {
                if (e.key === 'Escape') finish(null);
            });
            on(saveBtn, 'click', () => {
                const { circleSize, margin } = circleBounds();
                const OUTPUT_SIZE = 512;
                const sx = (margin - state.left) / state.scale;
                const sy = (margin - state.top) / state.scale;
                const sSize = circleSize / state.scale;
                const canvas = document.createElement('canvas');
                canvas.width = OUTPUT_SIZE;
                canvas.height = OUTPUT_SIZE;
                const ctx = canvas.getContext('2d');
                if (!ctx) { finish(file); return; }
                ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
                canvas.toBlob((blob) => {
                    if (!blob) { finish(file); return; }
                    const baseName = String(file.name || 'avatar').replace(/\.[^.]+$/, '') || 'avatar';
                    finish(new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' }));
                }, 'image/jpeg', 0.92);
            });
        });
    }

    async setProfileAvatar(inputFile) {
        if (!inputFile) return;
        const target = String(this.myName()).trim();
        if (!inputFile.type || !inputFile.type.startsWith('image/')) {
            throw new Error('Нужен файл изображения');
        }
        const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
        if (inputFile.size > MAX_AVATAR_BYTES) {
            throw new Error('Аватар слишком большой. Выберите изображение до 2 МБ');
        }
        const file = await this.downscaleAvatarFile(inputFile);
        if (this.hasNativeAvatarBridge()) {
            const dataUrl = await this.readFileAsDataURL(file);
            await this.requestNativeAction({
                type: NativeMessageTypes.UPLOAD_AVATAR_REQUEST,
                dataUrl,
                mimeType: file.type || 'image/png',
                filename: file.name || 'avatar.png',
            });
            const objectUrl = URL.createObjectURL(file);
            this.saveStoredAvatar(target, objectUrl);
            this.updateAvatarViews();
            return;
        }
        const formData = new FormData();
        formData.append('file', file, file.name || 'avatar.png');
        const res = await this.apiFetch(this.apiRoutes.avatar.base, {
            method: 'POST',
            body: formData,
        });
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось сохранить аватар на сервере');
        }
        const objectUrl = URL.createObjectURL(file);
        this.saveStoredAvatar(target, objectUrl);
        this.updateAvatarViews();
    }

    async resetProfileAvatar() {
        const target = String(this.myName()).trim();
        if (this.hasNativeAvatarBridge()) {
            await this.requestNativeAction({
                type: NativeMessageTypes.DELETE_AVATAR_REQUEST,
            });
            this.saveStoredAvatar(target, null);
            this.updateAvatarViews();
            return;
        }
        const res = await this.apiFetch(this.apiRoutes.avatar.base, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
            throw new Error(await res.text() || 'Не удалось удалить аватар на сервере');
        }
        this.saveStoredAvatar(target, null);
        this.updateAvatarViews();
    }

    apiHeaders(extra = {}, { includeDeviceId = false } = {}) {
        const headers = { ...extra };
        if (this.S.session?.token && !headers.Authorization) {
            headers.Authorization = `Bearer ${this.S.session.token}`;
        }
        const deviceId = includeDeviceId ? this.currentDeviceId() : '';
        if (deviceId) {
            headers['X-Zali-Device-ID'] = deviceId;
        }
        return headers;
    }

    nativeApiResponse(payload) {
        const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
        const status = Number(data.status || 0) || 0;
        const body = String(data.body || '');
        const headers = data.headers && typeof data.headers === 'object' ? data.headers : {};
        return {
            ok: !!data.ok || (status >= 200 && status < 300),
            status,
            headers,
            text: async () => body,
            json: async () => JSON.parse(body || 'null'),
            blob: async () => {
                const contentType = String(headers['content-type'] || headers['Content-Type'] || 'application/octet-stream');
                return new Blob([body], { type: contentType });
            },
        };
    }

    async nativeApiFetch(path, { method = 'GET', headers = {}, body = null, includeDeviceId = false, timeoutMs = API_REQUEST_TIMEOUT_MS } = {}) {
        // Native owns the per-attempt timeout AND the retry, because only it can force a
        // brand-new connection (a half-open HTTP/2 connection is otherwise reused and
        // stalls again). Give the JS bridge a generous abandon timeout so it does not
        // give up before native has finished its short retries.
        const payload = await this.requestNativeAction({
            type: NativeMessageTypes.API_REQUEST,
            method,
            path,
            headers,
            body: typeof body === 'string' ? body : '',
            includeDeviceId: !!includeDeviceId,
            timeoutMs,
        }, timeoutMs + 5000);
        return this.nativeApiResponse(payload);
    }

    async _acquireApiSlot(interactive = false) {
        const MAX = 5;
        if (!this._apiWaiters) this._apiWaiters = [];
        if (!this._apiWaitersHigh) this._apiWaitersHigh = [];
        if ((this._apiInFlight || 0) < MAX) {
            this._apiInFlight = (this._apiInFlight || 0) + 1;
            return;
        }
        // Interactive (user-clicked) requests jump ahead of queued background
        // maintenance calls (contacts/users/servers refresh, key republish, cloud
        // vault backup — all fired in bursts from postAuthSetup) instead of waiting
        // behind however many of those already queued first. Without this, clicking
        // "add contact" during that startup burst could sit queued long enough to
        // look like the click did nothing, when it was really just stuck in line.
        const queue = interactive ? this._apiWaitersHigh : this._apiWaiters;
        await new Promise(resolve => queue.push(resolve));
        // The slot was handed to us by _releaseApiSlot (count already reserved).
    }

    _releaseApiSlot() {
        const next = (this._apiWaitersHigh && this._apiWaitersHigh.length)
            ? this._apiWaitersHigh.shift()
            : (this._apiWaiters && this._apiWaiters.length) ? this._apiWaiters.shift() : null;
        if (next) {
            next(); // hand the in-flight slot straight to the next waiter
        } else {
            this._apiInFlight = Math.max(0, (this._apiInFlight || 0) - 1);
        }
    }

    // Global concurrency limit. On macOS every apiFetch goes through the native
    // URLSession pool (≈6 connections/host); a burst of background requests (cloud
    // vault tickets, key republish) would exhaust it and make the NEXT request stall
    // for the full 12s timeout. Capping in-flight requests keeps the pool healthy.
    async apiFetch(path, options = {}) {
        await this._acquireApiSlot(!!options.interactive);
        try {
            return await this._apiFetchImpl(path, options);
        } finally {
            this._releaseApiSlot();
        }
    }

    async _apiFetchImpl(path, options = {}) {
        const method = String(options?.method || 'GET').toUpperCase();
        const requestId = this.newRequestId();
        this.trace(`apiFetch request method=${method} path=${path} request_id=${requestId} auth=${!!this.S.session?.token}`);
        const {
            includeDeviceId = false,
            allowSessionInvalidation = false,
            timeoutMs = 0,
            interactive = false,
            headers: optionHeaders,
            ...fetchOptions
        } = options || {};
        const headers = this.apiHeaders(
            { 'X-Request-ID': requestId, ...(optionHeaders || {}) },
            { includeDeviceId: !!includeDeviceId },
        );
        if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
        if (this.nativeSupports('apiRequest') && !(options.body instanceof FormData)) {
            const res = await this.nativeApiFetch(path, {
                method,
                headers,
                body: options.body,
                includeDeviceId,
                timeoutMs: timeoutMs || API_REQUEST_TIMEOUT_MS,
            });
            this.trace(`apiFetch native response method=${method} path=${path} request_id=${requestId} status=${res.status} ok=${res.ok}`);
            this.handleUnauthorizedApiResponse(res, headers, { allowSessionInvalidation });
            return res;
        }
        let timeoutId = null;
        let abortController = null;
        let abortForwarder = null;
        const originalSignal = fetchOptions.signal;
        if (timeoutMs > 0 && typeof AbortController !== 'undefined') {
            abortController = new AbortController();
            fetchOptions.signal = abortController.signal;
            timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
            if (originalSignal) {
                if (originalSignal.aborted) {
                    abortController.abort();
                } else {
                    abortForwarder = () => abortController.abort();
                    originalSignal.addEventListener('abort', abortForwarder, { once: true });
                }
            }
        }
        try {
            const res = await fetch(this.apiUrl(path), {
                ...fetchOptions,
                headers,
            });
            this.trace(`apiFetch response method=${method} path=${path} request_id=${requestId} status=${res.status} ok=${res.ok}`);
            this.handleUnauthorizedApiResponse(res, headers, { allowSessionInvalidation });
            return res;
        } catch (error) {
            this.trace(`apiFetch transport_error method=${method} path=${path} request_id=${requestId} err=${error?.message || error}`);
            throw error;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
            if (originalSignal && abortForwarder) {
                originalSignal.removeEventListener('abort', abortForwarder);
            }
        }
    }

    handleUnauthorizedApiResponse(res, headers = {}, { allowSessionInvalidation = false } = {}) {
        const status = Number(res?.status || 0);
        if (status === 403) {
            this.trace('apiFetch forbidden status=403 keep_session=true');
            return;
        }
        if (status !== 401) return;
        if (!allowSessionInvalidation) {
            this.trace('apiFetch unauthorized status=401 keep_session=true');
            return;
        }
        const currentToken = String(this.S.session?.token || '').trim();
        const headerToken = String(headers?.Authorization || '').replace(/^Bearer\s+/i, '').trim();
        if (!currentToken || headerToken !== currentToken || this.sessionBootstrapInProgress) return;
        if (this.sessionInvalidationInProgress) return;
        this.sessionInvalidationInProgress = true;
        this.forgetRecentAccountEntry(this.S.session?.username, currentToken);
        this.clearStoredSession();
        this.S.auth.dismissed = false;
        this.S.auth.error = 'Сессия истекла. Войдите заново.';
        this.applySession({ username: '', token: null, guest: true }, {
            persist: false,
            syncNative: true,
            connectVoiceSocket: false,
        });
        this.addLogEntry({
            type: 'WARN',
            msg: 'Сессия истекла или токен стал недействительным. Выполните вход заново.',
            ts: new Date().toLocaleTimeString()
        });
        setTimeout(() => {
            this.sessionInvalidationInProgress = false;
        }, 1000);
    }

    async bootstrapSession() {
        this.trace('bootstrapSession start');
        this.sessionBootstrapInProgress = true;
        try {
            const stored = this.loadStoredSession();
            const lastStored = this.loadStoredSession(this.lastAuthStorageKey());
            const injected = this.loadInjectedSession();
            const seenTokens = new Set();
            const candidates = [stored, lastStored, injected]
                .map(s => this.normalizeSession(s))
                .filter(s => {
                    const token = String(s?.token || '').trim();
                    if (!token || seenTokens.has(token)) return false;
                    // Skip already-expired tokens. Otherwise an expired stored token
                    // was applied as a "fallback" session and every request hit the
                    // server's "невалидный JWT" rejection — manifesting as 12s timeouts
                    // and empty history instead of a clean re-login prompt.
                    if (this.isTokenExpired(token)) {
                        this.trace(`bootstrapSession skip expired token username=${s?.username || ''}`);
                        return false;
                    }
                    seenTokens.add(token);
                    return true;
                });
            const hasCandidates = candidates.length > 0;
            // If we had a saved session but every token was expired, tell the user why
            // they are back at the login screen and clear the dead tokens.
            const hadStoredToken = !!(String(stored?.token || '').trim() || String(lastStored?.token || '').trim());
            if (!hasCandidates && hadStoredToken) {
                this.clearStoredSession();
                this.clearLastStoredSession();
                this.S.auth.error = 'Сессия истекла. Войдите заново.';
                this.addLogEntry({ type: 'WARN', msg: 'Сохранённая сессия истекла — войдите заново', ts: new Date().toLocaleTimeString() });
            }

            let restored = false;
            let invalidateStoredSession = false;
            for (const candidate of candidates) {
                const result = await this.restoreSession(candidate);
                restored = !!result?.ok;
                invalidateStoredSession = invalidateStoredSession || !!result?.invalidate;
                if (restored) break;
            }

            if (!restored) {
                if (invalidateStoredSession && stored?.token) this.clearStoredSession();
                if (invalidateStoredSession && lastStored?.token) this.clearLastStoredSession();
                if (hasCandidates && !invalidateStoredSession) {
                    const fallback = candidates[0];
                    this.trace(`bootstrapSession fallback session username=${fallback?.username || ''} tokenSet=${!!fallback?.token}`);
                    this.applySession(fallback, { persist: false, syncNative: false });
                    this.startPostAuthSetup({
                        reason: 'bootstrapSession-fallback',
                        restoreStoredUnlockSecret: true,
                        resetVault: true,
                    });
                    this.S.auth.error = 'Не удалось проверить последний вход сейчас. Сессия будет восстановлена при следующей попытке.';
                    this.updateAuthView();
                } else {
                    this.applySession({ username: '', token: null, guest: true }, { persist: false });
                }
            }

            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;

            if (this.S.session?.token) {
                this.startPostAuthSetup({
                    reason: 'bootstrapSession',
                    restoreStoredUnlockSecret: true,
                });
            } else {
                this.S.contacts = [];
                this.S.users = [];
                this.S.servers = [];
                this.ensureServerSelection();
                this.renderContacts();
                this.renderServerInterface();
                this.scheduleRenderMessages();
            }
            this.updateAuthView();
            this.applyNetworkConfigToInputs();
            this.syncNativeNetworkConfig();
            this.updateSendButtonState();
            if (this.nativeSupports('sessionSync')) {
                this.syncNativeSession();
            }
        } finally {
            this.sessionBootstrapInProgress = false;
            this.rehydratePendingOutbox();
            this.scheduleFlushPendingOutbox(300);
            this.trace('bootstrapSession done');
        }
    }

    async restoreSession(session) {
        try {
            const token = session?.token || null;
            if (!token) return false;
            this.trace(`restoreSession start username=${session?.username || ''} tokenSet=${!!token}`);
            const res = await this.apiFetch(this.apiRoutes.auth.me, {
                allowSessionInvalidation: true,
                timeoutMs: SESSION_RESTORE_TIMEOUT_MS,
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });
            if (!res.ok) {
                const status = Number(res.status || 0);
                if (status === 401 || status === 403) {
                    this.trace(`restoreSession unauthorized status=${status}`);
                    return { ok: false, invalidate: true };
                }
                this.trace(`restoreSession retryable status=${status}`);
                return { ok: false, invalidate: false };
            }
            const data = await res.json();
            this.trace(`restoreSession success username=${data.username || session.username || ''}`);
            this.applySession({
                username: data.username || session.username || '',
                token,
                guest: false,
            }, { persist: true, syncNative: true });
            if (typeof data.cloudVaultSyncEnabled !== 'undefined') {
                this.applyVaultCloudSyncEnabled(!!data.cloudVaultSyncEnabled, { persistLocal: true });
            }
            return {
                ok: true,
                invalidate: false,
                username: data.username || session.username || '',
                token,
            };
        } catch (e) {
            this.trace(`restoreSession failed error=${e?.message || e}`);
            return { ok: false, invalidate: false };
        }
    }

    applySession(session, { persist = true, syncNative = true, connectVoiceSocket = true } = {}) {
        const previousUsername = this.S.session?.username;
        const previousToken = this.S.session?.token;
        const username = session?.username || '';
        const token = session?.token || null;
        const guest = !!session?.guest || !token;
        this.trace(`applySession username=${username} tokenSet=${!!token} guest=${guest} persist=${persist} syncNative=${syncNative}`);

        if (previousUsername !== username || previousToken !== token) {
            // A deferred cache save scheduled under the OLD account must land now,
            // while _userSuffix() still resolves to that account — once the session
            // switches, the debounced timer would write the old user's chats under
            // the new user's storage key.
            this.flushPendingMessageCacheSave();
            // The one-shot cloud-vault fetch guard is per-account: without resetting it,
            // the next account logged in during this page session would skip its own
            // on-demand vault fetch and mint a temporary key instead of adopting the
            // real key from its vault (key divergence on the account-switch flow).
            this._cloudVaultResolveFetchDone = false;
            this.S.current = null;
            this.S.activeServer = null;
            this.S.activeChannel = null;
            this.S.activeConversationType = 'dm';
            this.S.draftAttachments = [];
            this.resetVoiceState({ preserveInvite: false });
            this.disconnectBrowserVoiceSocket();
            this.S.auth.vaultPassphrase = '';
            this.setServerModalState({
                mode: 'create',
                serverId: null,
                members: [],
                loading: false,
                saving: false,
                error: '',
            });
            this.closeServerOverlay();
        }

        this.S.session = { username, token, guest };
        if (username && username !== previousUsername) {
            const userCachedMessages = this.loadStoredMessageCache();
            this.S.chats = userCachedMessages.chats && typeof userCachedMessages.chats === 'object'
                ? userCachedMessages.chats
                : {};
            this.S.serverChats = userCachedMessages.serverChats && typeof userCachedMessages.serverChats === 'object'
                ? userCachedMessages.serverChats
                : {};
            const cachedContacts = this.loadStoredContacts();
            const localContacts = this.localConversationContacts();
            this.S.contacts = Array.from(new Set([...cachedContacts, ...localContacts]))
                .filter(contact => contact !== username);
            this.S.contacts.forEach(contact => this.initChat(contact));
            this.lastNativeConversationKeySignature = '';
            this.syncNativeConversationKeys(this.loadStoredConversationKeys());
        }
        if (token) {
            this.S.auth.dismissed = true;
        }
        if (persist) {
            if (token) {
                this.saveStoredSession(this.S.session);
            } else {
                this.clearStoredSession();
            }
        }

        this.updateAuthView();
        const overlay = document.getElementById('authOverlay');
        if (overlay && token) {
            overlay.classList.remove('visible');
        }
        this.normalizeDmChatStore();
        this.renderSidebarProfile();
        this.renderRecentAccounts();
        this.updateContactControls();
        this.renderContacts();
        this.scheduleRenderMessages();
        this.updateSendButtonState();
        if (syncNative) {
            this.syncNativeSession();
        }
        if (connectVoiceSocket && !this.nativeSupports('voice')) {
            this.connectBrowserVoiceSocket();
        }
        if (!this.sessionBootstrapInProgress) {
            this.rehydratePendingOutbox();
            this.recoverOrphanSendingMessages();
            this.scheduleFlushPendingOutbox(300);
        }
    }

    clearAuthInputs() {
        const usernameInput = document.getElementById('authUsername');
        const passwordInput = document.getElementById('authPassword');
        if (usernameInput) usernameInput.value = '';
        if (passwordInput) passwordInput.value = '';
    }

    updateContactControls() {
        const enabled = !!this.S.session?.token;
        const contactAddBtn = document.getElementById('contactAddBtn');
        if (contactAddBtn) {
            contactAddBtn.disabled = !enabled;
        }
        if (!enabled) {
            this.exitContactAddMode({ restoreSearch: false });
            this.setContactStatus('');
        }
        this.updateContactAddButtonState();
    }

    enterContactAddMode() {
        if (!this.S.session?.token) return;
        this.S.contactAddMode = true;
        this._searchQBeforeContactAdd = this.S.searchQ || '';
        const input = document.getElementById('searchInput');
        if (input) {
            input.value = '';
            input.placeholder = 'Логин контакта';
            input.focus();
        }
        this.setContactStatus('');
        this.updateContactAddButtonState();
        void this.loadUsers('').then(() => this.renderContactSuggestions(true));
    }

    exitContactAddMode({ restoreSearch = true } = {}) {
        if (!this.S.contactAddMode) return;
        this.S.contactAddMode = false;
        const input = document.getElementById('searchInput');
        const restoredQuery = restoreSearch ? (this._searchQBeforeContactAdd || '') : '';
        if (input) {
            input.value = restoredQuery;
            input.placeholder = 'Поиск...';
        }
        this.S.searchQ = restoredQuery;
        this._searchQBeforeContactAdd = '';
        this.hideContactSuggestions();
        this.setContactStatus('');
        this.updateContactAddButtonState();
        this.renderContacts();
    }

    updateContactAddButtonState() {
        const contactAddBtn = document.getElementById('contactAddBtn');
        const input = document.getElementById('searchInput');
        if (!contactAddBtn) return;
        const enabled = !!this.S.session?.token;
        const addMode = !!this.S.contactAddMode;
        const hasText = addMode && !!String(input?.value || '').trim();
        contactAddBtn.disabled = !enabled;
        contactAddBtn.classList.toggle('is-empty', addMode && !hasText);
        contactAddBtn.classList.toggle('is-active', addMode);
        contactAddBtn.title = !enabled
            ? 'Войдите, чтобы добавить контакт'
            : (!addMode ? 'Добавить контакт' : (hasText ? 'Добавить контакт' : 'Введите логин контакта'));
    }

    setContactStatus(message = '', tone = '') {
        const status = document.getElementById('contactStatus');
        if (!status) return;
        const text = String(message || '').trim();
        status.textContent = text;
        if (tone) {
            status.dataset.tone = tone;
        } else {
            delete status.dataset.tone;
        }
        status.hidden = !text;
    }

    resolveContactInputUsername(rawValue) {
        const query = String(rawValue || '').trim();
        if (!query) return '';
        const lower = query.toLowerCase();
        const users = Array.isArray(this.S.users) ? this.S.users.filter(Boolean) : [];
        const exactUser = users.find(user => String(user || '').trim().toLowerCase() === lower);
        if (exactUser) return String(exactUser).trim();
        const suggestions = this.getContactSuggestions(query);
        if (suggestions.length === 1) {
            return String(suggestions[0]).trim();
        }
        return query;
    }

    getContactSuggestions(query = '') {
        const q = String(query || '').trim().toLowerCase();
        const me = this.myName();
        const existing = new Set((this.S.contacts || []).map(contact => String(contact).toLowerCase()));
        return (this.S.users || [])
            .filter(Boolean)
            .filter(contact => contact !== me)
            .filter(contact => !existing.has(String(contact).toLowerCase()))
            .filter(contact => !q || String(contact).toLowerCase().includes(q))
            .slice(0, 8);
    }

    hideContactSuggestions() {
        const outer = document.getElementById('contactSuggestionsWrap');
        const wrap = document.getElementById('contactSuggestions');
        if (outer) outer.hidden = true;
        if (!wrap) return;
        wrap.hidden = true;
        wrap.innerHTML = '';
    }

    renderContactSuggestions(force = false) {
        const outer = document.getElementById('contactSuggestionsWrap');
        const wrap = document.getElementById('contactSuggestions');
        const input = document.getElementById('searchInput');
        if (!outer || !wrap || !input) return;

        if (!this.S.session?.token || !this.S.contactAddMode) {
            this.hideContactSuggestions();
            return;
        }

        const query = input.value || '';
        const list = this.getContactSuggestions(query);
        const hasFocus = document.activeElement === input;
        const shouldShow = force || hasFocus || query.trim().length > 0;

        if (!shouldShow) {
            outer.hidden = true;
            wrap.hidden = true;
            wrap.innerHTML = '';
            return;
        }

        if (list.length === 0) {
            outer.hidden = false;
            wrap.hidden = false;
            wrap.innerHTML = `
                <div class="contact-suggest-empty">
                    Ничего не найдено
                </div>
            `;
            return;
        }

        outer.hidden = false;
        wrap.hidden = false;
        wrap.innerHTML = list.map(username => {
            return `
                <button class="contact-suggest-item" type="button" data-username="${this.esc(username)}">
                    <div class="contact-suggest-ava">${this.renderAvatarHTML(username, 'avatar-img', username)}</div>
                    <div class="contact-suggest-meta">
                        <div class="contact-suggest-name">${this.esc(username)}</div>
                        <div class="contact-suggest-hint">Добавить и начать чат</div>
                    </div>
                    <div class="contact-suggest-plus">+</div>
                </button>
            `;
        }).join('');
    }

    setAuthMode(mode, { clearInputs = true, focus = true } = {}) {
        this.S.auth.mode = mode === 'register' ? 'register' : 'login';
        this.S.auth.error = '';
        this.S.auth.loading = false;
        this.S.auth.fieldsCleared = false;
        if (clearInputs) {
            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;
        }
        this.updateAuthView();
        if (focus) {
            const usernameInput = document.getElementById('authUsername');
            if (usernameInput) usernameInput.focus();
        }
    }

    syncNativeSession() {
        if (!this.nativeSupports('sessionSync')) return;
        const deviceId = this.currentDeviceId();
        const username = this.S.session.username;
        const token = this.S.session.token || '';
        const guest = this.S.session.guest;
        // Skip redundant SET_SESSION: startup/auth calls applySession several times,
        // and every identical re-send made native tear down and re-open the WebSocket,
        // which showed up as the connection flapping (connect/disconnect repeatedly)
        // and left the client briefly offline — so real-time messages were missed.
        const signature = `${username}|${token}|${guest ? 1 : 0}|${deviceId}`;
        if (signature === this._lastNativeSessionSignature) {
            this.trace(`syncNativeSession skip duplicate username=${username}`);
            return;
        }
        this._lastNativeSessionSignature = signature;
        this.trace(`syncNativeSession username=${username} tokenSet=${!!token} deviceId=${deviceId || 'none'}`);
        this.postNativeMessage({
            type: NativeMessageTypes.SET_SESSION,
            username,
            token,
            guest,
            deviceId,
        });
    }

    async loadContacts() {
        try {
            this.trace(`loadContacts start user=${this.myName()} tokenSet=${!!this.S.session?.token}`);
            if (!this.S.session?.token) {
                this.S.contacts = [];
                this.renderContacts();
                return;
            }
            const res = await this.apiFetch(this.apiRoutes.contacts.list);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                this.trace(`loadContacts failed status=${res.status} body=${text.slice(0, 300)}`);
                if (!this.S.contacts.length) {
                    const cachedContacts = this.loadStoredContacts();
                    if (cachedContacts.length) this.setContacts(cachedContacts);
                }
                this.renderContacts();
                return;
            }
            const data = await res.json();
            const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
            this.trace(`loadContacts success count=${contacts.length} contacts=${contacts.join(',')}`);
            this.setContacts(contacts);
        } catch (e) {
            this.trace(`loadContacts error=${e?.message || e}`);
            this.renderContacts();
        }
    }

    async loadUsers(query = '') {
        try {
            this.trace(`loadUsers start user=${this.myName()} tokenSet=${!!this.S.session?.token}`);
            if (!this.S.session?.token) {
                this.S.users = [];
                return;
            }
            const search = String(query || '').trim();
            const res = await this.apiFetch(this.apiRoutes.users.search(search));
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                this.trace(`loadUsers failed status=${res.status} body=${text.slice(0, 300)}`);
                return;
            }
            const users = await res.json();
            this.trace(`loadUsers success count=${Array.isArray(users) ? users.length : 0} users=${Array.isArray(users) ? users.join(',') : 'invalid'}`);
            this.setUsers(users);
        } catch (e) {
            this.trace(`loadUsers error=${e?.message || e}`);
        }
    }

    startPostAuthSetup({
        passphrase = '',
        reason = 'login',
        saveUnlockSecret = false,
        restoreStoredUnlockSecret = false,
        resetVault = false,
    } = {}) {
        const token = String(this.S.session?.token || '').trim();
        if (!token) return;
        const runId = ++this.postAuthSetupRunId;
        void (async () => {
            // A newer run supersedes this one. bootstrapSession can fire two setups
            // back-to-back (fallback + token branch); without a real guard both ran
            // the full request set concurrently, doubling load and causing 12s
            // timeouts. Bail at each checkpoint if a newer run started.
            const superseded = () => this.postAuthSetupRunId !== runId;
            this.postAuthSetupInFlight = true;
            const tStart = this.nowMs();
            try {
                let code = String(passphrase || this.S.auth?.vaultPassphrase || '').trim();
                if (!code && restoreStoredUnlockSecret) {
                    code = await this.timeStage('loadVaultUnlockSecret', () => this.loadVaultUnlockSecret(token));
                    if (code) {
                        this.S.auth.vaultPassphrase = code;
                    }
                }
                if (superseded()) { this.trace(`postAuthSetup superseded reason=${reason} run=${runId}`); return; }
                if (saveUnlockSecret && code) {
                    await this.timeStage('saveVaultUnlockSecret', () => this.saveVaultUnlockSecret(code, token));
                }
                if (resetVault) {
                    await this.timeStage('ensureServerVaultReset', () => this.ensureServerVaultReset({ reason }));
                }
                // Contacts/users/servers are independent of device registration, so fire
                // them NOW in parallel with bootstrapDeviceTrust instead of after it —
                // they all multiplex over the single HTTP/2 connection. Key envelopes do
                // need the device registered, so they wait for bootstrap.
                const uiLoads = Promise.allSettled([
                    this.timeStage('loadContacts', () => this.loadContacts()),
                    this.timeStage('loadUsers', () => this.loadUsers()),
                    this.timeStage('loadServers', () => this.loadServers({ silent: true })),
                ]);
                await this.timeStage('bootstrapDeviceTrust', () => this.bootstrapDeviceTrust());
                await this.timeStage('restoreCloudVaultSnapshot', () => this.restoreCloudVaultSnapshot({ reason }));
                if (superseded()) { this.trace(`postAuthSetup superseded reason=${reason} run=${runId}`); return; }
                await Promise.allSettled([
                    this.timeStage('syncIncomingKeyEnvelopes', () => this.syncIncomingKeyEnvelopes({ reason })),
                    uiLoads,
                ]);
                this.addLogEntry({ type: 'INFO', msg: `⏱ postAuthSetup ВСЕГО (reason=${reason}): ${Math.round(this.nowMs() - tStart)} мс`, ts: new Date().toLocaleTimeString() });
                this.trace(`postAuthSetup done reason=${reason} run=${runId}`);
                // Background, OFF the critical path. These are slow (cloud vault backup
                // POSTs a package + a history ticket per scope; key republish sends one
                // request per peer device) but none are needed to render the chat, so
                // they must not block or starve the loads above.
                if (!superseded()) {
                    if (code) {
                        void this.timeStage('syncCloudVaultPackage(bg)', () => this.syncCloudVaultPackage({ passphrase: code, reason }));
                    }
                    void this.timeStage('retryPublishConversationKeys(bg)', () => this.retryPublishConversationKeys({ reason }));
                }
            } catch (e) {
                this.trace(`postAuthSetup failed reason=${reason} run=${runId} error=${e?.message || e}`);
            } finally {
                if (runId === this.postAuthSetupRunId) {
                    this.postAuthSetupInFlight = false;
                }
            }
        })();
    }

    async executeAuth(mode, username, password, { logAttempt = true } = {}) {
        const errorBox = document.getElementById('authError');
        this.S.auth.loading = true;
        this.updateAuthView();

        try {
            if (this.isWindowsNativeAuth()) {
                return await this.executeNativeAuth(mode, username, password, { logAttempt });
            }

            const endpoint = mode === 'register' ? this.apiRoutes.auth.register : this.apiRoutes.auth.login;
            if (mode === 'register' && logAttempt) {
                this.addLogEntry({
                    type: 'INFO',
                    msg: `Попытка регистрации: ${username}`,
                    ts: new Date().toLocaleTimeString()
                });
            }

            const requestAuth = async () => {
                return await this.apiFetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password }),
                    timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
                    interactive: true,
                });
            };

            let res;
            let lastError = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    res = await requestAuth();
                    lastError = null;
                    break;
                } catch (err) {
                    lastError = err;
                    const msg = String(err?.message || err || '');
                    if (!/load failed|failed to fetch|network error|abort/i.test(msg) || attempt === 1) {
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
            }

            if (!res) {
                throw lastError || new Error('Не удалось связаться с сервером');
            }

            if (mode === 'register') {
                if (!res.ok) {
                    const text = await res.text();
                    if (res.status === 409 || /Пользователь уже существует/i.test(text)) {
                        this.addLogEntry({
                            type: 'INFO',
                            msg: `Аккаунт ${username} уже есть, пробуем войти с этим паролем`,
                            ts: new Date().toLocaleTimeString()
                        });

                        const recovered = await this.executeAuth('login', username, password, { logAttempt: false });
                        if (recovered) {
                            this.addLogEntry({
                                type: 'SUCCESS',
                                msg: `Вход восстановлен для ${username}`,
                                ts: new Date().toLocaleTimeString()
                            });
                            return true;
                        }
                    }

                    this.addLogEntry({
                        type: 'WARN',
                        msg: `Регистрация отклонена для ${username}: ${text || res.status}`,
                        ts: new Date().toLocaleTimeString()
                    });
                    throw new Error(text || 'Не удалось зарегистрироваться');
                }

                const data = await res.json();
                this.applySession({
                    username: data.username || username,
                    token: data.token,
                    guest: false,
                });
                if (typeof data.cloudVaultSyncEnabled !== 'undefined') {
                    this.applyVaultCloudSyncEnabled(!!data.cloudVaultSyncEnabled, { persistLocal: true });
                }
                this.S.auth.vaultPassphrase = String(password || '').trim();
                this.setAuthMode('login', { clearInputs: true, focus: false });
                this.startPostAuthSetup({
                    passphrase: password,
                    reason: 'register',
                    saveUnlockSecret: true,
                    resetVault: true,
                });

                this.addLogEntry({
                    type: 'SUCCESS',
                    msg: `Регистрация успешна, вход выполнен как ${this.myName()}`,
                    ts: new Date().toLocaleTimeString()
                });
                this.clearAuthInputs();
                return true;
            }

            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Не удалось войти');
            }

            const data = await res.json();
            this.applySession({
                username: data.username || username,
                token: data.token,
                guest: false,
            });
            if (typeof data.cloudVaultSyncEnabled !== 'undefined') {
                this.applyVaultCloudSyncEnabled(!!data.cloudVaultSyncEnabled, { persistLocal: true });
            }
            this.S.auth.vaultPassphrase = String(password || '').trim();
            this.setAuthMode('login', { clearInputs: true, focus: false });
            this.startPostAuthSetup({
                passphrase: password,
                reason: 'login',
                saveUnlockSecret: true,
                resetVault: true,
            });
            this.clearAuthInputs();
            this.addLogEntry({ type: 'SUCCESS', msg: `Вход выполнен как ${this.myName()}`, ts: new Date().toLocaleTimeString() });
            return true;
        } catch (e) {
            const raw = e.message || 'Ошибка входа';
            const apiBaseUrl = this.getApiBaseUrl();
            const friendly = /load failed|failed to fetch|network error|abort/i.test(raw)
                ? `Не удалось связаться с сервером (${apiBaseUrl}). Проверь адрес или запусти backend.`
                : raw;
            this.S.auth.error = friendly;
            if (errorBox) errorBox.textContent = friendly;
            if (mode === 'register') {
                this.addLogEntry({
                    type: 'ERROR',
                    msg: `Ошибка регистрации для ${username}: ${friendly}`,
                    ts: new Date().toLocaleTimeString()
                });
            }
            return false;
        } finally {
            this.S.auth.loading = false;
            this.updateAuthView();
        }
    }

    async executeNativeAuth(mode, username, password, { logAttempt = true } = {}) {
        const requestId = `auth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const request = {
            type: NativeMessageTypes.AUTH_REQUEST,
            mode,
            username,
            password,
            requestId,
        };

        if (mode === 'register' && logAttempt) {
            this.addLogEntry({
                type: 'INFO',
                msg: `Попытка регистрации: ${username}`,
                ts: new Date().toLocaleTimeString()
            });
        }

        const nativeAuthTimeoutMs = mode === 'register'
            ? AUTH_REQUEST_TIMEOUT_MS * 2
            : AUTH_REQUEST_TIMEOUT_MS;
        const payload = await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.nativeAuthRequests.delete(requestId);
                reject(new Error('Не удалось связаться с сервером'));
            }, nativeAuthTimeoutMs);

            this.nativeAuthRequests.set(requestId, { resolve, reject, timeoutId });

            if (!this.postNativeMessage(request)) {
                clearTimeout(timeoutId);
                this.nativeAuthRequests.delete(requestId);
                reject(new Error('Не удалось связаться с сервером'));
            }
        });

        const data = payload?.data || payload;
        this.applySession({
            username: data.username || username,
            token: data.token,
            guest: false,
        });
        if (typeof data.cloudVaultSyncEnabled !== 'undefined') {
            this.applyVaultCloudSyncEnabled(!!data.cloudVaultSyncEnabled, { persistLocal: true });
        }
        this.S.auth.vaultPassphrase = String(password || '').trim();
        this.setAuthMode('login', { clearInputs: true, focus: false });
        this.startPostAuthSetup({
            passphrase: password,
            reason: 'native-auth',
            saveUnlockSecret: true,
            resetVault: true,
        });
        this.clearAuthInputs();
        this.addLogEntry({
            type: 'SUCCESS',
            msg: mode === 'register'
                ? `Регистрация успешна, вход выполнен как ${this.myName()}`
                : `Вход выполнен как ${this.myName()}`,
            ts: new Date().toLocaleTimeString()
        });
        return true;
    }

    async requestNativeAction(payload, timeoutMs = 15000) {
        const requestId = String(payload?.requestId || `native-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const request = { ...payload, requestId };
        return await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.nativeRequests.delete(requestId);
                reject(new Error('Не удалось связаться с сервером'));
            }, timeoutMs);

            this.nativeRequests.set(requestId, { resolve, reject, timeoutId });

            if (!this.postNativeMessage(request)) {
                clearTimeout(timeoutId);
                this.nativeRequests.delete(requestId);
                reject(new Error('Не удалось связаться с сервером'));
            }
        });
    }

    onNativeResponse(payload) {
        if (!payload || typeof payload !== 'object') return;
        const requestId = String(payload.requestId || '').trim();
        if (!requestId) return;
        const pending = this.nativeRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        this.nativeRequests.delete(requestId);
        if (payload.ok) {
            pending.resolve(payload);
        } else {
            pending.reject(new Error(payload.error || 'Операция не удалась'));
        }
    }

    onNativeAuthResponse(payload) {
        if (!payload || typeof payload !== 'object') return;
        const requestId = String(payload.requestId || '').trim();
        if (!requestId) return;
        const pending = this.nativeAuthRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        this.nativeAuthRequests.delete(requestId);
        if (payload.ok) {
            pending.resolve(payload);
        } else {
            pending.reject(new Error(payload.error || 'Не удалось войти'));
        }
    }

    async submitAuth(mode) {
        if (this.S.auth.loading) {
            return;
        }

        const usernameInput = document.getElementById('authUsername');
        const passwordInput = document.getElementById('authPassword');
        const username = (usernameInput?.value || '').trim();
        const password = passwordInput?.value || '';
        const errorBox = document.getElementById('authError');

        if (errorBox) errorBox.textContent = '';
        this.S.auth.error = '';
        if (!username || !password) {
            const msg = 'Введите логин и пароль';
            this.S.auth.error = msg;
            if (errorBox) errorBox.textContent = msg;
            return;
        }

        if (mode === 'register') {
            if (username.length > 64) {
                const msg = 'Логин слишком длинный: максимум 64 символа';
                this.S.auth.error = msg;
                if (errorBox) errorBox.textContent = msg;
                this.addLogEntry({ type: 'WARN', msg: `Регистрация отклонена для ${username}: ${msg}`, ts: new Date().toLocaleTimeString() });
                return;
            }

            if (password.length < 6) {
                const msg = 'Пароль должен быть не менее 6 символов';
                this.S.auth.error = msg;
                if (errorBox) errorBox.textContent = msg;
                this.addLogEntry({ type: 'WARN', msg: `Регистрация отклонена для ${username}: ${msg}`, ts: new Date().toLocaleTimeString() });
                return;
            }
        }

        const authApiBaseUrl = document.getElementById('authApiBaseUrl');
        const typedApiBaseUrl = String(authApiBaseUrl?.value || '').trim();
        if (typedApiBaseUrl) {
            try {
                const current = this.loadNetworkConfig();
                const typedWsBaseUrl = this.deriveWsBaseUrl(typedApiBaseUrl);
                if (typedApiBaseUrl !== current.apiBaseUrl || typedWsBaseUrl !== current.wsBaseUrl) {
                    this.setNetworkConfig({
                        apiBaseUrl: typedApiBaseUrl,
                        wsBaseUrl: typedWsBaseUrl,
                        iceServers: current.iceServers,
                    });
                }
            } catch (e) {
                const msg = e?.message || 'Не удалось сохранить адрес сервера';
                this.S.auth.error = msg;
                if (errorBox) errorBox.textContent = msg;
                return;
            }
        }

        return this.executeAuth(mode, username, password);
    }

    continueAsGuest() {
        this.S.auth.dismissed = true;
        this.S.auth.error = '';
        this.clearAuthInputs();
        this.S.auth.fieldsCleared = true;
        this.applySession({ username: '', token: null, guest: true }, { persist: false });
        this.loadContacts();
        this.updateAuthView();
    }

    async logout() {
        this.S.auth.dismissed = false;
        this.S.auth.error = '';
        this.setAuthMode('login', { clearInputs: true, focus: false });
        this.clearStoredSession();
        this.applySession({ username: '', token: null, guest: true }, { persist: false, syncNative: false, connectVoiceSocket: false });
        this.S.contacts = [];
        this.S.users = [];
        this.S.current = null;
        this.resetVoiceState({ preserveInvite: false });
        this.disconnectBrowserVoiceSocket();
        this.renderContacts();
        this.scheduleRenderMessages();
        this.updateAuthView();
        this.addLogEntry({ type: 'WARN', msg: 'Сеанс завершён', ts: new Date().toLocaleTimeString() });
    }

    async addContactFromInput(usernameOverride = null) {
        if (!this.S.session?.token) {
            const msg = 'Сначала войдите в аккаунт, чтобы добавлять контакты';
            this.addLogEntry({ type: 'WARN', msg, ts: new Date().toLocaleTimeString() });
            this.S.auth.error = msg;
            this.setContactStatus(msg, 'error');
            this.updateAuthView();
            return;
        }

        const input = document.getElementById('searchInput');
        const rawUsername = (usernameOverride ?? input?.value ?? '').trim();
        if (!rawUsername) {
            const msg = 'Введите логин контакта';
            this.setContactStatus(msg);
            if (input) {
                input.focus();
                input.select?.();
            }
            this.renderContactSuggestions(true);
            return;
        }

        this.setContactStatus('');
        const lowerRawUsername = rawUsername.toLowerCase();
        const exactInCache = Array.isArray(this.S.users)
            ? this.S.users.some(user => String(user || '').trim().toLowerCase() === lowerRawUsername)
            : false;
        let username = this.resolveContactInputUsername(rawUsername);

        if (!exactInCache && rawUsername.length >= 3) {
            await this.loadUsers(rawUsername);
            const exactAfterLoad = Array.isArray(this.S.users)
                ? this.S.users.find(user => String(user || '').trim().toLowerCase() === lowerRawUsername)
                : null;
            if (exactAfterLoad) {
                username = String(exactAfterLoad).trim();
            } else {
                const suggestions = this.getContactSuggestions(rawUsername);
                if (suggestions.length === 1) {
                    username = String(suggestions[0]).trim();
                } else if (suggestions.length > 1) {
                    const msg = 'Выберите контакт из списка';
                    this.setContactStatus(msg, 'error');
                    this.renderContactSuggestions(true);
                    if (input) input.focus();
                    return;
                }
            }
        }

        if (!username) {
            const msg = 'Введите логин контакта';
            this.setContactStatus(msg);
            if (input) input.focus();
            return;
        }

        if (this.S.contacts?.some?.(u => String(u || '').trim().toLowerCase() === username.toLowerCase())) {
            const msg = `Контакт уже добавлен: ${username}`;
            this.setContactStatus(msg, 'success');
            this.addLogEntry({ type: 'INFO', msg, ts: new Date().toLocaleTimeString() });
            if (input) {
                input.value = '';
                input.focus();
            }
            this.updateContactAddButtonState();
            this.hideContactSuggestions();
            return;
        }

        try {
            if (this.isWindowsNativeAuth()) {
                const payload = await this.requestNativeAction({
                    type: NativeMessageTypes.ADD_CONTACT_REQUEST,
                    username,
                });
                this.setContacts(Array.isArray(payload?.data?.contacts) ? payload.data.contacts : []);
                if (input) input.value = '';
                this.updateContactAddButtonState();
                this.hideContactSuggestions();
                this.setContactStatus(`Контакт добавлен: ${username}`, 'success');
                this.addLogEntry({ type: 'SUCCESS', msg: `Контакт добавлен: ${username}`, ts: new Date().toLocaleTimeString() });
                return;
            }
            const requestAddContact = async () => {
                return await this.apiFetch(this.apiRoutes.contacts.list, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username }),
                    interactive: true,
                });
            };

            let res = null;
            let lastError = null;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    res = await requestAddContact();
                    lastError = null;
                    break;
                } catch (err) {
                    lastError = err;
                    const msg = String(err?.message || err || '');
                    if (!/load failed|failed to fetch|network error|abort/i.test(msg) || attempt === 1) {
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
            }
            if (!res) {
                throw lastError || new Error('Не удалось добавить контакт');
            }
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Не удалось добавить контакт');
            }
            const data = await res.json();
            this.setContacts(Array.isArray(data?.contacts) ? data.contacts : []);
            if (input) input.value = '';
            this.updateContactAddButtonState();
            this.hideContactSuggestions();
            this.setContactStatus(`Контакт добавлен: ${username}`, 'success');
            this.addLogEntry({ type: 'SUCCESS', msg: `Контакт добавлен: ${username}`, ts: new Date().toLocaleTimeString() });
        } catch (e) {
            const apiBase = this.getApiBaseUrl();
            const rawMessage = String(e?.message || 'Не удалось добавить контакт');
            const message = /load failed|failed to fetch|network error|abort/i.test(rawMessage)
                ? `Не удалось добавить контакт на ${apiBase}. Проверь адрес сервера и попробуй ещё раз.`
                : rawMessage;
            this.setContactStatus(message, 'error');
            if (/пользователь не найден/i.test(message)) {
                this.renderContactSuggestions(true);
            }
            this.addLogEntry({ type: 'ERROR', msg: message, ts: new Date().toLocaleTimeString() });
        }
    }

    async removeContact(username) {
        if (!this.S.session?.token) {
            this.addLogEntry({ type: 'WARN', msg: 'Удаление контактов доступно только после входа', ts: new Date().toLocaleTimeString() });
            return;
        }
        try {
            if (this.isWindowsNativeAuth()) {
                const payload = await this.requestNativeAction({
                    type: NativeMessageTypes.REMOVE_CONTACT_REQUEST,
                    username,
                });
                this.setContacts(Array.isArray(payload?.data?.contacts) ? payload.data.contacts : []);
                return;
            }
            const res = await this.apiFetch(this.apiRoutes.contacts.byUsername(username), { method: 'DELETE', interactive: true });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Не удалось удалить контакт');
            }
            const data = await res.json();
            this.setContacts(Array.isArray(data?.contacts) ? data.contacts : []);
        } catch (e) {
            this.addLogEntry({ type: 'ERROR', msg: e.message || 'Не удалось удалить контакт', ts: new Date().toLocaleTimeString() });
        }
    }

    updateAuthView() {
        const overlay = document.getElementById('authOverlay');
        if (overlay) {
            const shouldShow = !this.S.session?.token && !this.S.auth.dismissed;
            overlay.classList.toggle('visible', shouldShow);
        }

        const authTitle = document.getElementById('authTitle');
        const authHint = document.getElementById('authHint');
        const authError = document.getElementById('authError');
        const loginBtn = document.getElementById('authLoginBtn');
        const regBtn = document.getElementById('authRegisterBtn');
        const guestBtn = document.getElementById('authGuestBtn');
        const vaultSyncNote = document.getElementById('authVaultSyncNote');
        if (authTitle) authTitle.textContent = this.S.auth.mode === 'register' ? 'Создание аккаунта' : 'Вход в аккаунт';
        if (authHint) authHint.textContent = this.S.auth.mode === 'register'
            ? 'Зарегистрируйтесь, чтобы сохранить контакты и историю.'
            : 'Войдите, чтобы синхронизировать сообщения и контакты.';
        if (vaultSyncNote) {
            vaultSyncNote.textContent = this.isVaultCloudSyncEnabled()
                ? 'Ключи переписки будут подгружены из облака при входе.'
                : 'Ключи переписки останутся только на этом устройстве.';
        }
        if (authError) authError.textContent = this.S.auth.error || '';
        if (loginBtn) loginBtn.textContent = this.S.auth.loading
            ? 'Входим...'
            : (this.S.auth.mode === 'register' ? 'Создать аккаунт' : 'Войти');
        if (regBtn) regBtn.textContent = this.S.auth.mode === 'register' ? 'Уже есть аккаунт' : 'Создать аккаунт';
        if (loginBtn) loginBtn.disabled = this.S.auth.loading;
        if (regBtn) regBtn.disabled = this.S.auth.loading;
        if (guestBtn) guestBtn.disabled = this.S.auth.loading;
        this.syncAuthNetworkInput();
        this.renderVaultCloudSyncControls();
        if (!this.S.session?.token && overlay && overlay.classList.contains('visible') && !this.S.auth.fieldsCleared && !this.S.auth.loading) {
            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;
        }
        this.renderSidebarProfile();
    }

    initChat(name) { 
        if (!this.S.chats[name]) this.S.chats[name] = []; 
    }

    ensureContact(name) {
        if (!name || name === this.myName()) return;
        if (!this.S.contacts.includes(name)) {
            this.S.contacts = [name, ...this.S.contacts];
        }
        this.initChat(name);
    }

    normalizeAttachment(att = {}) {
        const mimeType = att.mimeType || att.mime_type || '';
        const kind = att.kind || (
            mimeType.startsWith('video/') ? 'video' :
            mimeType === 'image/gif' ? 'gif' :
            mimeType.startsWith('image/') ? 'image' : 'file'
        );
        return {
            id: att.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: att.name || 'attachment',
            mimeType,
            kind,
            size: Number(att.size || 0),
            dataUrl: att.dataUrl || att.data_url || att.url || '',
            archivePath: att.archivePath || att.archive_path || '',
        };
    }

    normalizeAttachments(attachments) {
        return Array.isArray(attachments) ? attachments.map(att => this.normalizeAttachment(att)) : [];
    }

    formatFileSize(bytes) {
        const size = Number(bytes || 0);
        if (!Number.isFinite(size) || size <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = size;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }
        const precision = unitIndex === 0 ? 0 : value < 10 ? 1 : 0;
        return `${value.toFixed(precision)} ${units[unitIndex]}`;
    }

    inferMimeType(file) {
        if (file && file.type) return file.type;
        const name = (file && file.name || '').toLowerCase();
        if (name.endsWith('.png')) return 'image/png';
        if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
        if (name.endsWith('.webp')) return 'image/webp';
        if (name.endsWith('.gif')) return 'image/gif';
        if (name.endsWith('.mp4')) return 'video/mp4';
        if (name.endsWith('.webm')) return 'video/webm';
        return 'application/octet-stream';
    }

    fileToDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл'));
            reader.readAsDataURL(file);
        });
    }

    async fileToAttachment(file) {
        const mimeType = this.inferMimeType(file);
        const kind = mimeType.startsWith('video/') ? 'video' : mimeType === 'image/gif' ? 'gif' : mimeType.startsWith('image/') ? 'image' : 'file';
        const dataUrl = await this.fileToDataUrl(file);
        return this.normalizeAttachment({
            name: file.name,
            mimeType,
            kind,
            size: file.size,
            dataUrl,
        });
    }

    async handleFiles(fileList) {
        const files = Array.from(fileList || []);
        if (files.length === 0) return;
        const attachments = await Promise.all(files.map(file => this.fileToAttachment(file)));
        this.S.draftAttachments = this.S.draftAttachments.concat(attachments);
        this.renderDraftAttachments();
        this.updateSendButtonState();
    }

    clearDraftAttachments() {
        this.S.draftAttachments = [];
        this.renderDraftAttachments();
        this.updateSendButtonState();
    }

    renderDraftAttachments() {
        const wrap = document.getElementById('draftAttachments');
        if (!wrap) return;

        if (!this.S.draftAttachments.length) {
            wrap.innerHTML = '';
            wrap.classList.remove('has-items');
            return;
        }

        wrap.classList.add('has-items');
        wrap.innerHTML = this.S.draftAttachments.map(att => {
            const thumb = this.renderAttachmentPreview(att, true);
            return `<div class="draft-att" data-att-id="${this.esc(att.id)}">
                <button class="draft-att-remove" type="button" data-att-id="${this.esc(att.id)}" title="Удалить вложение">×</button>
                ${thumb}
                <div class="draft-att-name">${this.esc(att.name)}</div>
            </div>`;
        }).join('');
    }

    resizeComposer() {
        const inp = document.getElementById('msgInput');
        if (!inp) return;
        inp.style.height = 'auto';
        inp.style.height = `${Math.min(inp.scrollHeight, 140)}px`;
    }

    extractUrls(text) {
        if (!text) return [];
        const re = /https?:\/\/[^\s<>()"]+/gi;
        return String(text).match(re) || [];
    }

    isTenorUrl(url) {
        try {
            const u = new URL(url);
            return /(^|\.)tenor\.com$/.test(u.hostname) || /(^|\.)media\d*\.tenor\.com$/.test(u.hostname) || /(^|\.)c\.tenor\.com$/.test(u.hostname);
        } catch (e) {
            return false;
        }
    }

    tenorCacheKey(url) {
        return `tenor:${url}`;
    }

    requestTenorResolution(url) {
        const key = this.tenorCacheKey(url);
        if (this.tenorCache.has(key) || this.tenorPending.has(key)) return;
        this.tenorPending.add(key);

        if (this.nativeSupports('tenor')) {
            this.postNativeMessage({
                type: NativeMessageTypes.RESOLVE_TENOR,
                url,
                requestId: key,
            });
        } else {
            this.tenorPending.delete(key);
        }
    }

    onTenorResolved(payload) {
        let data = payload;
        if (typeof payload === 'string') {
            try {
                data = JSON.parse(payload);
            } catch (e) {
                return;
            }
        }

        if (!data || !data.sourceUrl) return;
        const key = this.tenorCacheKey(data.sourceUrl);
        this.tenorPending.delete(key);

        if (data.mediaUrl) {
            this.tenorCache.set(key, {
                mediaUrl: data.mediaUrl,
                mimeType: data.mimeType || '',
                kind: data.kind || '',
            });
            this.scheduleRenderMessages();
            this.renderContacts();
        }
    }

    isDirectMediaUrl(url) {
        try {
            const u = new URL(url);
            return /\.(gif|png|jpe?g|webp|mp4|webm)(\?.*)?$/i.test(u.pathname);
        } catch (e) {
            return false;
        }
    }

    renderMessageText(text) {
        const urls = this.extractUrls(text);
        if (!urls.length) {
            return this.esc(text).replace(/\n/g, '<br>');
        }

        const escaped = this.esc(text).replace(/\n/g, '<br>');
        return escaped.replace(/https?:\/\/[^\s<>()"]+/gi, (match) => {
            const rawUrl = match.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
            const safeHref = this.esc(rawUrl);
            return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${match}</a>`;
        });
    }

    mediaShellStyle(src, { gifLike = false, fallbackAspectRatio = '16 / 9' } = {}) {
        if (gifLike) return '';
        const cached = src ? this.mediaSizeCache.get(src) : null;
        const width = Number(cached?.width || 0);
        const height = Number(cached?.height || 0);
        const ratio = width > 0 && height > 0 ? `${width} / ${height}` : fallbackAspectRatio;
        return ratio ? ` style="aspect-ratio: ${ratio};"` : '';
    }

    safeAttachmentUrl(url) {
        const value = String(url || '').trim();
        if (!value) return '';
        if (/^(data|blob):/i.test(value)) return value;
        try {
            const parsed = new URL(value, window.location.href);
            return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
        } catch (e) {
            return '';
        }
    }

    renderAttachmentPreview(att, compact = false, options = {}) {
        const attachment = this.normalizeAttachment(att);
        const src = this.safeAttachmentUrl(attachment.dataUrl || attachment.url || '');
        const gifLike = !!options.gifLike || attachment.kind === 'gif' || attachment.mimeType === 'image/gif';
        const showControls = options.controls !== undefined ? !!options.controls : !gifLike;
        if (!src) {
            return `<div class="media-unknown">${this.esc(attachment.name)}</div>`;
        }

        if (attachment.kind === 'video' || (attachment.mimeType || '').startsWith('video/')) {
            const shellClass = `discord-media-shell discord-media-shell-video${gifLike ? ' discord-media-shell-gif' : ''}${compact ? ' compact' : ''}`;
            const shellStyle = this.mediaShellStyle(src, { gifLike });
            return `<div class="${shellClass}"${shellStyle}>
                <video class="media media-video${compact ? ' compact' : ''}${gifLike ? ' media-gif-like' : ''}" data-gif-like="${gifLike ? '1' : '0'}" src="${this.esc(src)}"${showControls ? ' controls' : ''} autoplay loop muted playsinline preload="${gifLike ? 'auto' : 'metadata'}"></video>
            </div>`;
        }

        if (attachment.kind === 'gif' || attachment.mimeType === 'image/gif' || (attachment.mimeType || '').startsWith('image/')) {
            const gifClass = gifLike ? ' media-gif-like' : '';
            const shellGifClass = gifLike ? ' discord-media-shell-gif' : '';
            const shellStyle = this.mediaShellStyle(src, { gifLike });
            return `<div class="discord-media-shell discord-media-shell-image${shellGifClass}${compact ? ' compact' : ''}"${shellStyle}>
                <img class="media media-img${compact ? ' compact' : ''}${gifClass}" src="${this.esc(src)}" alt="${this.esc(attachment.name)}" loading="lazy" decoding="async" fetchpriority="low">
            </div>`;
        }

        const sizeLabel = this.formatFileSize(attachment.size);
        if (compact) {
            return `<a class="file-chip${compact ? ' compact' : ''}" href="${this.esc(src)}" download="${this.esc(attachment.name)}">
                <span class="file-chip-name">${this.esc(attachment.name)}</span>
                <span class="file-chip-size">${this.esc(sizeLabel)}</span>
            </a>`;
        }

        return `<a class="file-message" href="${this.esc(src)}" download="${this.esc(attachment.name)}">
            <span class="file-message-name">${this.esc(attachment.name)}</span>
            <span class="file-message-size">${this.esc(sizeLabel)}</span>
        </a>`;
    }

    sanitizeDecryptionErrorText(text) {
        const value = String(text || '').trim();
        if (!value) return '';
        if (/^(?:🚨\s*)?\[Ошибка расшифрования:[^\]]*\]$/.test(value)) {
            return '';
        }
        return text;
    }

    hydrateGifMedia(root = document) {
        const videos = root.querySelectorAll?.('video.media-gif-like[data-gif-like="1"]') || [];
        videos.forEach(video => {
            if (!(video instanceof HTMLMediaElement)) return;
            if (video.dataset.gifBound === '1') return;

            video.dataset.gifBound = '1';
            video.loop = true;
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';
            video.style.backgroundColor = 'transparent';
            video.style.objectFit = 'contain';
            video.style.width = '100%';
            video.style.height = '100%';
            video.style.removeProperty('aspect-ratio');

            const shell = video.closest('.discord-media-shell');
            const src = video.currentSrc || video.src || video.getAttribute('src') || '';
            const cacheSize = (width, height) => {
                if (!src || !width || !height) return;
                this.mediaSizeCache.set(src, { width, height });
            };

            const ensurePlaying = () => {
                if (video.dataset.userPaused === '1') return;
                if (video.paused) {
                    video.play?.().catch(() => {});
                }
            };

            const syncFromMetadata = () => {
                const width = Number(video.videoWidth || 0);
                const height = Number(video.videoHeight || 0);
                cacheSize(width, height);
                ensurePlaying();
            };

            video.addEventListener('loadedmetadata', syncFromMetadata, { once: true });
            video.addEventListener('loadeddata', syncFromMetadata, { once: true });

            if (window.IntersectionObserver) {
                const observer = new IntersectionObserver((entries) => {
                    const entry = entries[0];
                    if (!entry) return;
                    if (video.dataset.userPaused === '1') return;
                    if (entry.isIntersecting) {
                        ensurePlaying();
                    }
                }, { root: null, threshold: 0.15, rootMargin: '160px' });
                observer.observe(video);
                video.dataset.gifObserver = '1';
                return;
            }

            ensurePlaying();
        });

        const images = root.querySelectorAll?.('img.media-gif-like:not([data-gif-like="1"])') || [];
        images.forEach(img => {
            if (!(img instanceof HTMLImageElement)) return;
            if (img.dataset.gifBound === '1') return;
            img.dataset.gifBound = '1';
            const shell = img.closest('.discord-media-shell');
            const src = img.currentSrc || img.src || img.getAttribute('src') || '';
            const cacheSize = (width, height) => {
                if (!src || !width || !height) return;
                this.mediaSizeCache.set(src, { width, height });
            };
            const syncFromImage = () => {
                const width = Number(img.naturalWidth || 0);
                const height = Number(img.naturalHeight || 0);
                cacheSize(width, height);
            };
            if (img.complete) {
                syncFromImage();
            } else {
                img.addEventListener('load', syncFromImage, { once: true });
            }
        });
    }

    renderUrlPreview(url) {
        if (!url) return '';
        let path = '';
        try {
            path = new URL(url).pathname.toLowerCase();
        } catch (e) {
            path = url.toLowerCase();
        }

        if (this.isTenorUrl(url)) {
            if (this.isDirectMediaUrl(url)) {
                return this.renderAttachmentPreview({
                    name: 'Tenor',
                    mimeType: path.endsWith('.mp4') ? 'video/mp4' : path.endsWith('.webm') ? 'video/webm' : 'image/gif',
                    kind: path.endsWith('.mp4') || path.endsWith('.webm') ? 'video' : 'gif',
                    dataUrl: url
                }, false, { gifLike: true });
            }

            const cached = this.tenorCache.get(this.tenorCacheKey(url));
            if (cached?.mediaUrl) {
                const mimeType = cached.mimeType || (path.endsWith('.mp4') ? 'video/mp4' : 'image/gif');
                const kind = cached.kind || (mimeType.startsWith('video/') ? 'video' : 'gif');
                return this.renderAttachmentPreview({
                    name: 'Tenor',
                    mimeType,
                    kind,
                    dataUrl: cached.mediaUrl
                }, false, { gifLike: true });
            }

            this.requestTenorResolution(url);
            return `<div class="media media-tenor media-tenor-pending">
                <div class="tenor-badge">Tenor GIF</div>
                <div class="tenor-hint">Загружаем анимацию...</div>
            </div>`;
        }

        if (this.isDirectMediaUrl(url)) {
            return this.renderAttachmentPreview({
                name: url.split('/').pop() || 'media',
                mimeType: path.endsWith('.mp4') ? 'video/mp4' : path.endsWith('.webm') ? 'video/webm' : path.endsWith('.gif') ? 'image/gif' : 'image/*',
                kind: path.endsWith('.mp4') || path.endsWith('.webm') ? 'video' : 'image',
                dataUrl: url
            });
        }

        return '';
    }

    renderMessageBody(msg) {
        if (msg?.kind === 'call') {
            return this.renderCallMessage(msg);
        }
        const attachments = this.normalizeAttachments(msg.attachments);
        const urls = this.extractUrls(msg.text);
        const isOnlyUrl = (msg.text || '').trim() && urls.length === 1 && (msg.text || '').trim() === urls[0];
        const previewBlocks = urls.map(url => this.renderUrlPreview(url)).filter(Boolean);
        const bodyParts = [];

        if (!isOnlyUrl || previewBlocks.length === 0 || (msg.text || '').trim() !== urls[0]) {
            if (msg.text) {
                bodyParts.push(`<div class="msg-text">${this.renderMessageText(msg.text)}</div>`);
            }
        }

        if (attachments.length) {
            bodyParts.push(`<div class="msg-attachments">${attachments.map(att => this.renderAttachmentPreview(att)).join('')}</div>`);
        }

        if (previewBlocks.length) {
            bodyParts.push(`<div class="msg-attachments msg-link-previews">${previewBlocks.join('')}</div>`);
        }

        return bodyParts.join('');
    }

    renderCallMessage(msg) {
        const call = msg?.call || {};
        const direction = String(call.direction || '').trim() || (this.isOutgoingMessage(msg) ? 'outgoing' : 'incoming');
        const outcome = String(call.outcome || '').trim() || 'completed';
        const peer = String(call.peer || msg.receiver || msg.sender || '').trim();
        const startedAt = call.connectedAt || call.startedAt || msg.timestamp;
        const endedAt = call.endedAt || msg.timestamp;
        const durationMs = Number(call.durationMs || 0) || 0;
        const whenLabel = this.fmtDate(startedAt);
        const timeLabel = this.fmtTime(startedAt || endedAt);
        const durationLabel = this.formatDuration(durationMs);
        const title = outcome === 'missed'
            ? `Пропущенный звонок`
            : outcome === 'rejected'
                ? `Звонок отклонён`
                : outcome === 'cancelled'
                    ? `Звонок отменён`
                    : direction === 'outgoing'
                        ? `Исходящий звонок`
                        : `Входящий звонок`;
        const subject = direction === 'outgoing'
            ? `К ${peer || 'контакту'}`
            : `От ${peer || 'контакта'}`;
        const durationText = durationLabel === '00:00' && outcome !== 'completed'
            ? '00:00'
            : durationLabel;
        return `
            <div class="call-card ${this.esc(outcome)} ${this.esc(direction)}">
                <div class="call-card-top">
                    <div class="call-card-icon">${outcome === 'completed' ? this.uiIcon('phone') : this.uiIcon('close')}</div>
                    <div class="call-card-copy">
                        <div class="call-card-title">${this.esc(title)}</div>
                        <div class="call-card-sub">${this.esc(subject)}</div>
                    </div>
                </div>
                <div class="call-card-meta">
                    <span>Когда: ${this.esc(whenLabel ? `${whenLabel}, ${timeLabel}` : timeLabel)}</span>
                    <span>Длительность: ${this.esc(durationText)}</span>
                </div>
            </div>
        `;
    }

    messageHasMedia(msg) {
        const attachments = this.normalizeAttachments(msg.attachments);
        if (attachments.some(att => att.kind === 'image' || att.kind === 'video' || att.kind === 'gif' || (att.mimeType || '').startsWith('image/') || (att.mimeType || '').startsWith('video/'))) {
            return true;
        }
        const urls = this.extractUrls(msg.text);
        return urls.some(url => this.isTenorUrl(url) || this.isDirectMediaUrl(url));
    }

    messageIsGifOnly(msg) {
        const text = (msg.text || '').trim();
        if (text) return false;

        const attachments = this.normalizeAttachments(msg.attachments);
        if (attachments.length > 0) {
            return attachments.every(att =>
                att.kind === 'gif' ||
                att.mimeType === 'image/gif' ||
                (att.mimeType || '').startsWith('image/')
            );
        }

        const urls = this.extractUrls(msg.text);
        if (urls.length !== 1) return false;

        const url = urls[0];
        if (!this.isTenorUrl(url) && !this.isDirectMediaUrl(url)) return false;
        const path = (() => {
            try { return new URL(url).pathname.toLowerCase(); }
            catch (e) { return url.toLowerCase(); }
        })();
        return path.endsWith('.gif') || this.isTenorUrl(url);
    }

    messageSummary(msg) {
        if (msg?.kind === 'call') {
            const call = msg.call || {};
            const direction = String(call.direction || '').trim();
            const outcome = String(call.outcome || '').trim();
            const peer = String(call.peer || msg.receiver || msg.sender || '').trim();
            const duration = this.formatDuration(call.durationMs || 0);
            if (outcome === 'missed') return `Пропущенный звонок${peer ? ` · ${peer}` : ''}`;
            if (outcome === 'rejected') return `Отклонённый звонок${peer ? ` · ${peer}` : ''}`;
            if (outcome === 'cancelled') return `Отменённый звонок${peer ? ` · ${peer}` : ''}`;
            return `Звонок${peer ? ` · ${peer}` : ''}${duration ? ` · ${duration}` : ''}`;
        }
        const attachments = this.normalizeAttachments(msg.attachments);
        if (attachments.length) {
            const first = attachments[0];
            if (first.kind === 'video' || first.mimeType.startsWith('video/')) return 'Видео';
            if (first.kind === 'gif' || first.mimeType === 'image/gif') return 'GIF';
            if (first.mimeType.startsWith('image/')) return 'Фото';
            return 'Файл';
        }

        const urls = this.extractUrls(msg.text);
        if (urls.some(url => this.isTenorUrl(url))) {
            return 'Tenor GIF';
        }

        const text = (msg.text || '').trim();
        if (!text) return 'Сообщение';
        return text.length > 32 ? `${text.slice(0, 32)}…` : text;
    }

    messageRenderKey(msg) {
        if (!msg || typeof msg !== 'object') return '';
        if (msg.clientId) return `cid:${msg.clientId}`;
        if (msg.id) return `id:${msg.id}`;
        const attachments = this.normalizeAttachments(msg.attachments);
        const attachmentKey = attachments
            .map(att => `${att.name}:${att.kind}:${att.size}:${att.mimeType}`)
            .join('|');
        const call = msg.kind === 'call' ? msg.call || {} : {};
        return [
            msg.kind || '',
            msg.sender || '',
            msg.receiver || '',
            msg.timestamp || '',
            msg.text || '',
            call.roomId || '',
            call.direction || '',
            call.outcome || '',
            call.peer || '',
            call.durationMs || '',
            attachmentKey,
        ].join('::');
    }

    normalizeReactions(reactions) {
        if (!reactions) return [];
        const list = Array.isArray(reactions)
            ? reactions
            : Object.entries(reactions).map(([emoji, count]) => ({ emoji, count }));
        return list
            .map(item => ({
                emoji: String(item?.emoji || '').trim(),
                count: Number(item?.count || 0) || 0,
            }))
            .filter(item => item.emoji && item.count > 0)
            .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
    }

    findMessageById(messageId) {
        const id = String(messageId || '').trim();
        if (!id) return null;
        for (const [peer, msgs] of Object.entries(this.S.chats)) {
            const index = msgs.findIndex(msg => String(msg.id || '').trim() === id || String(msg.clientId || '').trim() === id);
            if (index >= 0) {
                return { peer, msg: msgs[index], index };
            }
        }
        for (const [key, msgs] of Object.entries(this.S.serverChats || {})) {
            const index = msgs.findIndex(msg => String(msg.id || '').trim() === id || String(msg.clientId || '').trim() === id);
            if (index >= 0) {
                return { peer: key, msg: msgs[index], index, serverKey: key };
            }
        }
        return null;
    }

    renderMessageReactions(msg) {
        const messageId = String(msg?.id || '').trim();
        if (!messageId) return '';

        const reactions = this.normalizeReactions(msg.reactions);
        const myReaction = String(msg.myReaction || '').trim();
        return reactions.length
            ? `<div class="reaction-row">
                ${reactions.map(reaction => {
                    const mine = myReaction && myReaction === reaction.emoji ? ' mine' : '';
                    return `<span class="reaction-chip${mine}" title="${this.esc(reaction.emoji)}">
                        <span class="reaction-emoji">${this.esc(reaction.emoji)}</span>
                        <span class="reaction-count">${reaction.count}</span>
                    </span>`;
                }).join('')}
            </div>`
            : '';
    }

    ensureReactionMenu() {
        let menu = document.getElementById('reactionMenu');
        if (menu) return menu;
        menu = document.createElement('div');
        menu.id = 'reactionMenu';
        menu.className = 'reaction-menu';
        menu.setAttribute('aria-hidden', 'true');
        menu.innerHTML = this.reactionOptions.map(emoji => (
            `<button class="reaction-btn" type="button" data-menu-reaction="${this.esc(emoji)}" aria-label="${this.esc(emoji)}"><span class="reaction-btn-emoji">${this.esc(emoji)}</span></button>`
        )).join('');
        document.body.appendChild(menu);

        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-menu-reaction]');
            if (!btn) return;
            const emoji = btn.getAttribute('data-menu-reaction');
            const messageId = menu.getAttribute('data-message-id');
            if (messageId && emoji) {
                this.addReaction(messageId, emoji);
            }
            this.hideReactionMenu();
        });

        return menu;
    }

    showReactionMenu(messageEl, messageId, x, y) {
        const menu = this.ensureReactionMenu();
        if (!menu || !messageEl) return;
        menu.setAttribute('data-message-id', messageId);
        menu.classList.add('visible');
        menu.setAttribute('aria-hidden', 'false');
        menu.style.left = '0px';
        menu.style.top = '0px';
        const menuRect = menu.getBoundingClientRect();
        const anchor = messageEl.querySelector('.bwrap') || messageEl;
        const anchorRect = anchor.getBoundingClientRect();
        const pad = 12;
        const gap = 10;
        const maxLeft = window.innerWidth - menuRect.width - pad;
        const maxTop = window.innerHeight - menuRect.height - pad;
        const preferredLeft = anchorRect.left + (anchorRect.width - menuRect.width) / 2;
        const fallbackLeft = Number.isFinite(x) ? x - menuRect.width / 2 : preferredLeft;
        const left = Math.max(pad, Math.min(Number.isFinite(preferredLeft) ? preferredLeft : fallbackLeft, maxLeft));
        const topAbove = anchorRect.top - menuRect.height - gap;
        const topBelow = anchorRect.bottom + gap;
        const preferredTop = topAbove >= pad ? topAbove : topBelow;
        const fallbackTop = Number.isFinite(y) ? y - menuRect.height - gap : preferredTop;
        const top = Math.max(pad, Math.min(Number.isFinite(preferredTop) ? preferredTop : fallbackTop, maxTop));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }

    hideReactionMenu() {
        const menu = document.getElementById('reactionMenu');
        if (!menu) return;
        menu.classList.remove('visible');
        menu.setAttribute('aria-hidden', 'true');
        menu.removeAttribute('data-message-id');
    }

    markMessageSeen(msg) {
        const key = this.messageRenderKey(msg);
        if (key) this.messageAnimSeen.add(key);
    }

    dmSidebarSignature() {
        const q = String(this.S.searchQ || '').toLowerCase();
        const me = this.myName();
        return (this.S.contacts || [])
            .filter(contact => contact !== me && (!q || String(contact || '').toLowerCase().includes(q)))
            .map((contact, index) => ({
                name: contact,
                lastMessageAt: this.conversationLastMessageAt(contact),
                unread: Number(this.S.unread?.[contact] || 0),
                lastKey: this.messageRenderKey((this.S.chats?.[contact] || []).slice(-1)[0] || {}),
                active: contact === this.S.current ? 1 : 0,
                index,
            }))
            .sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }) || a.index - b.index)
            .map(item => `${item.name}:${item.lastMessageAt}:${item.unread}:${item.lastKey}:${item.active}`)
            .join('|');
    }

    messageStableSignature(msg = {}) {
        if (!msg || typeof msg !== 'object') return '';
        const reactions = Array.isArray(msg.reactions) ? msg.reactions.length : 0;
        const attachments = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
        return [
            this.messageRenderKey(msg),
            String(msg.status || ''),
            String(msg.text || '').length,
            reactions,
            attachments,
            String(msg.myReaction || ''),
        ].join(':');
    }

    activeMessagesSignature() {
        if (this.S.navMode === 'servers') {
            const key = this.serverChatKey();
            return (this.S.serverChats?.[key] || []).map(msg => this.messageStableSignature(msg)).join('|');
        }
        const peer = this.S.current;
        return (this.S.chats?.[peer] || []).map(msg => this.messageStableSignature(msg)).join('|');
    }

    markMessageStatus(clientId, status) {
        if (!clientId) return;
        let updated = false;
        for (const peer of Object.keys(this.S.chats)) {
            const msgs = this.S.chats[peer];
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].clientId === clientId) {
                    msgs[i].status = status;
                    if (status === 'error') msgs[i].error = true;
                    updated = true;
                    break;
                }
            }
            // No visible status badges in the message UI, so avoid full rerender.
            // The data is still updated for persistence / history consistency.
            if (updated) break;
        }
        if (!updated) {
            for (const key of Object.keys(this.S.serverChats || {})) {
                const msgs = this.S.serverChats[key];
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i].clientId === clientId) {
                        msgs[i].status = status;
                        if (status === 'error') msgs[i].error = true;
                        updated = true;
                        break;
                    }
                }
                if (updated) break;
            }
        }
    }

    finalizePendingMessage(clientId, messageId, { render = true } = {}) {
        const pendingId = String(clientId || '').trim();
        if (!pendingId) return false;
        const serverId = String(messageId || '').trim();
        let updated = false;
        for (const peer of Object.keys(this.S.chats)) {
            const msgs = this.S.chats[peer];
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (String(msgs[i].clientId || '').trim() === pendingId) {
                    msgs[i].status = 'sent';
                    delete msgs[i].error;
                    if (serverId) msgs[i].id = serverId;
                    updated = true;
                    break;
                }
            }
            if (updated) break;
        }
        if (!updated) {
            for (const key of Object.keys(this.S.serverChats || {})) {
                const msgs = this.S.serverChats[key];
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (String(msgs[i].clientId || '').trim() === pendingId) {
                        msgs[i].status = 'sent';
                        delete msgs[i].error;
                        if (serverId) msgs[i].id = serverId;
                        updated = true;
                        break;
                    }
                }
                if (updated) break;
            }
        }
        if (updated && render) {
            this.scheduleRenderMessages();
        }
        return updated;
    }

    applyLocalReaction(found, emoji) {
        if (!found || !found.msg) return;
        const message = found.msg;
        const current = String(message.myReaction || '').trim();
        const next = current === emoji ? '' : emoji;
        const map = new Map(this.normalizeReactions(message.reactions).map(item => [item.emoji, item.count]));

        if (current && map.has(current)) {
            const nextCount = (map.get(current) || 0) - 1;
            if (nextCount > 0) map.set(current, nextCount);
            else map.delete(current);
        }
        if (next) {
            map.set(next, (map.get(next) || 0) + 1);
        }

        message.myReaction = next;
        message.reactions = Array.from(map.entries())
            .map(([reactionEmoji, count]) => ({ emoji: reactionEmoji, count }))
            .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));

        const shouldRender = found.serverKey
            ? found.serverKey === this.currentServerChatKey()
            : found.peer === this.S.current;
        if (shouldRender) {
            this.scheduleRenderMessages();
        }
    }

    async addReaction(messageId, emoji) {
        const id = String(messageId || '').trim();
        const reaction = String(emoji || '').trim();
        if (!id || !reaction) return;

        const found = this.findMessageById(id);
        if (!found) return;

        const current = String(found.msg.myReaction || '').trim();
        const next = current === reaction ? '' : reaction;

        const hasRealServerId = !!found.msg.id && (!found.msg.clientId || String(found.msg.id) !== String(found.msg.clientId));
        if (!hasRealServerId) {
            this.applyLocalReaction(found, reaction);
            return;
        }

        if (this.nativeSupports('setReaction')) {
            const sent = this.postNativeMessage({
                type: NativeMessageTypes.SET_MESSAGE_REACTION,
                messageId: found.msg.id,
                emoji: next,
            });
            if (sent) {
                return;
            }
        }

        try {
            const res = await this.apiFetch(this.apiRoutes.messages.reaction(found.msg.id), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ emoji: next }),
            });

            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось поставить реакцию');
            }

            const payload = await res.json();
            this.onReactionUpdated(payload);
        } catch (e) {
            this.addLogEntry({ type: 'ERROR', msg: `Реакция не отправлена: ${e.message || e}`, ts: new Date().toLocaleTimeString() });
            this.applyLocalReaction(found, reaction);
        }
    }

    // --- DOM Rendering Methods ---

    renderContacts() {
        const el = document.getElementById('contacts');
        if (!el) return;
        this.updateSidebarModeLabel();
        if (this.S.navMode === 'servers') {
            this.renderServers(el);
            return;
        }
        const q = this.S.searchQ.toLowerCase();
        const list = this.S.contacts
            .filter(contact => contact !== this.myName() && (!q || contact.toLowerCase().includes(q)))
            .map((contact, index) => ({
                name: contact,
                lastMessageAt: this.conversationLastMessageAt(contact),
                index,
            }))
            .sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }) || a.index - b.index)
            .map(item => item.name);

        if (list.length === 0) {
            el.innerHTML = `<div style="text-align:center;color:var(--text3);font-size:11px;padding:24px 0">${q ? 'Ничего не найдено' : 'Добавьте первый контакт'}</div>`;
            return;
        }

        el.innerHTML = list.map(contact => {
            this.initChat(contact);
            const msgs = this.S.chats[contact];
            const last = msgs[msgs.length-1];
            let preview = '<span style="color:var(--text3);font-style:italic;font-size:10px">Начните диалог...</span>';
            if (last) {
                const who = last.sender === this.myName() ? 'Вы: ' : '';
                preview = who + this.esc(this.messageSummary(last));
            }
            const cnt = this.S.unread[contact] || 0;
            const badge = cnt > 0 ? `<div class="badge">${cnt > 99 ? '99+' : cnt}</div>` : '';
            const active = contact === this.S.current ? 'active' : '';
            const muted = this.isPeerMuted(contact);
            return `<div class="contact ${active}" data-name="${this.esc(contact)}">
                <div class="ava">${this.renderAvatarHTML(contact, 'avatar-img', contact)}</div>
                <div class="contact-info">
                    <div class="contact-name">${this.esc(contact)}</div>
                    <div class="contact-prev">${preview}</div>
                </div>
                <div class="contact-actions">
                    ${badge}
                    <button class="contact-mute-toggle${muted ? ' muted' : ''}" type="button" data-toggle-mute-peer="${this.esc(contact)}" title="${muted ? 'Включить уведомления' : 'Отключить уведомления'}" aria-label="${muted ? 'Включить уведомления' : 'Отключить уведомления'}">${muted ? '🔕' : '🔔'}</button>
                    <button class="contact-remove" type="button" data-remove-contact="${this.esc(contact)}" title="Удалить контакт">×</button>
                </div>
            </div>`;
        }).join('');
    }

    componentRegistry() {
        const componentVersion = (track, update, serverCompat, moduleVersion) =>
            `${track}0.1.${update}s${serverCompat}l${moduleVersion}`;
        return [
            {
                name: 'Zali Interface',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Web UI',
                description: 'Основной интерфейс: чаты, хаб, настройки, контакты, серверы и composer.',
                dependencies: ['ZaliBus', 'ZaliStyler', 'NetworkService', 'Rust Core'],
            },
            {
                name: 'Zali Styler',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Web UI',
                description: 'Темы, CSS-переменные, радиусы, сохранение выбранной схемы и динамическая кастомизация.',
                dependencies: ['localStorage', 'Swift UserDefaults bridge'],
            },
            {
                name: 'ZaliBus',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Runtime',
                description: 'Командная шина между веб-модулями, Swift WebView и нативными обработчиками.',
                dependencies: ['bootstrap.js', 'native_types.js'],
            },
            {
                name: 'Messaging Module',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Web UI',
                description: 'Отправка сообщений, вложения, реакции, история, локальная очередь и realtime-обновления.',
                dependencies: ['api_routes.js', 'NetworkService', 'Rust Core', 'WebSocket'],
            },
            {
                name: 'Contacts Module',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Web UI',
                description: 'Список диалогов, поиск пользователей, добавление контактов и аватары.',
                dependencies: ['api_routes.js', 'Avatar API', 'Message Cache'],
            },
            {
                name: 'Servers Module',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Web UI',
                description: 'Серверы, каналы, роли, участники, публичные серверы и настройки сервера.',
                dependencies: ['api_routes.js', 'Server API', 'Roles API'],
            },
            {
                name: 'Voice Module',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Realtime',
                description: 'Голосовые комнаты и прямые звонки через WebRTC-сигналинг.',
                dependencies: ['WebRTC', 'Voice WebSocket', 'TURN config'],
            },
            {
                name: 'Rust Core',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Core',
                description: 'Шифрование, упаковка сообщений, файловые операции и нативная core-логика.',
                dependencies: ['Swift bridge', 'ZaliCrypto', 'FileManager'],
            },
            {
                name: 'NetworkService',
                version: componentVersion('b', 1, 1, 1),
                layer: 'macOS Native',
                description: 'HTTP/WebSocket-клиент macOS, загрузка вложений, realtime и связка с сервером.',
                dependencies: ['URLSession', 'UserDefaults', 'Zali Server API'],
            },
            {
                name: 'Windows Native Shell',
                version: componentVersion('b', 2, 1, 2),
                layer: 'Windows Native',
                description: 'Wry/Tao оболочка Windows, WebView2, AppUserModelID, native bridge и сборка exe.',
                dependencies: ['WebView2', 'windows-sys', 'ZaliBus', 'Rust Core'],
            },
            {
                name: 'Native Notifications',
                version: componentVersion('b', 1, 1, 1),
                layer: 'macOS Native',
                description: 'Права macOS, доставка уведомлений и перепроверка статуса при активации приложения.',
                dependencies: ['UNUserNotificationCenter', 'ZaliMessenger.app bundle'],
            },
            {
                name: 'Zali Server',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Backend',
                description: 'REST API, WebSocket realtime, SQLite-хранилище, авторизация и uploads.',
                dependencies: ['axum 0.7', 'tokio 1.0', 'sqlx 0.7', 'jsonwebtoken 9.0'],
            },
        ];
    }

    renderHubComponents() {
        const box = document.getElementById('hubComponents');
        if (!box) return;
        const components = this.componentRegistry();
        box.innerHTML = `
            <div class="hub-components-head">
                <div>
                    <span class="settings-kicker">Components</span>
                    <h3>Компоненты приложения</h3>
                </div>
                <span>${components.length} модулей</span>
            </div>
            <div class="hub-components-list">
                ${components.map(component => `
                    <article class="hub-component-item">
                        <div class="hub-component-main">
                            <div class="hub-component-top">
                                <strong>${this.esc(component.name)}</strong>
                                <span>${this.esc(component.layer)}</span>
                            </div>
                            <p>${this.esc(component.description)}</p>
                        </div>
                        <div class="hub-component-meta">
                            <span class="hub-component-version">${this.esc(component.version)}</span>
                            <small>${component.dependencies.map(dep => this.esc(dep)).join(' / ')}</small>
                        </div>
                    </article>
                `).join('')}
            </div>
        `;
    }

    renderHub() {
        const grid = document.getElementById('hubGrid');
        if (!grid) return;
        const unreadTotal = Object.values(this.S.unread || {}).reduce((sum, value) => sum + Number(value || 0), 0);
        const contactsCount = Array.isArray(this.S.contacts) ? this.S.contacts.length : 0;
        const serversCount = Array.isArray(this.S.servers) ? this.S.servers.length : 0;
        const onlineLabel = this.S.wsOn ? 'WebSocket активен' : 'WebSocket не подключён';
        const cards = [
            {
                kind: 'news',
                title: 'Главные новости',
                value: 'UI v2',
                body: 'Новая сегментная навигация живёт отдельно от протокола сообщений.',
                action: 'Открыть ЛС',
                segment: 'dm',
            },
            {
                kind: 'notifications',
                title: 'Уведомления',
                value: unreadTotal ? `${unreadTotal}` : '0',
                body: unreadTotal ? 'Есть непрочитанные сообщения.' : 'Новых уведомлений пока нет.',
                action: 'К диалогам',
                segment: 'dm',
            },
            {
                kind: 'updates',
                title: 'Обновления',
                value: onlineLabel,
                body: `Контактов: ${contactsCount}. Серверов: ${serversCount}.`,
                action: 'Сервера',
                segment: 'servers',
            },
            {
                kind: 'apps',
                title: 'Подприложения',
                value: 'Плитки',
                body: 'Будущий дом для мини-модулей, виджетов и быстрых действий.',
                action: 'Открыть хаб',
                segment: 'hub',
            },
            {
                kind: 'components',
                title: 'Компоненты',
                value: 'Модули',
                body: 'Список частей приложения, их версий, зависимостей и зон ответственности.',
                action: 'Смотреть список',
                actionId: 'components',
            },
            {
                kind: 'settings',
                title: 'Настройки',
                value: 'Control',
                body: 'Профиль, тема, ключи, быстрые аккаунты и журнал событий.',
                action: 'Открыть настройки',
                segment: 'settings',
            },
        ];
        grid.innerHTML = cards.map(card => `
            <button class="hub-card hub-card--${this.esc(card.kind)}" type="button"${card.segment ? ` data-hub-segment="${this.esc(card.segment)}"` : ''}${card.actionId ? ` data-hub-action="${this.esc(card.actionId)}"` : ''}>
                <span class="hub-card-kicker">${this.esc(card.title)}</span>
                <strong>${this.esc(card.value)}</strong>
                <span>${this.esc(card.body)}</span>
                <em>${this.esc(card.action)}</em>
            </button>
        `).join('');
        this.renderHubComponents();
    }

    renderServers(el = null) {
        const target = el || document.getElementById('contacts');
        if (!target) return;
        this.ensureServersState();
        const q = this.S.searchQ.toLowerCase();
        const list = (this.S.servers || [])
            .filter(Boolean)
            .filter(server => {
                const haystack = `${server.name || ''} ${server.description || server.hint || ''}`.toLowerCase();
                return !q || haystack.includes(q);
            });

        const createTile = `
            <button class="server-item server-create" type="button" id="createServerBtn" title="Создать сервер" aria-label="Создать сервер">
                <span class="server-avatar server-create-plus">+</span>
                <div class="server-meta">
                    <div class="server-name">Создать сервер</div>
                    <div class="server-prev">Новый сервер, команда или сообщество</div>
                </div>
            </button>
        `;
        const joinTile = `
            <button class="server-item server-join" type="button" id="joinServerBtn" title="Войти по ссылке" aria-label="Войти по ссылке">
                <span class="server-avatar server-create-plus">↗</span>
                <div class="server-meta">
                    <div class="server-name">Войти по ссылке</div>
                    <div class="server-prev">Введите адрес сервера</div>
                </div>
            </button>
        `;
        const publicTile = `
            <button class="server-item server-public" type="button" id="publicServersBtn" title="Открыть публичные серверы" aria-label="Открыть публичные серверы">
                <span class="server-avatar server-create-plus">☰</span>
                <div class="server-meta">
                    <div class="server-name">Публичные серверы</div>
                    <div class="server-prev">Просмотр и вход из меню</div>
                </div>
            </button>
        `;

        target.innerHTML = `
            <div class="server-list">
                ${list.length === 0 ? `<div class="server-empty">
                    <div class="empty-ttl">Сервера не найдены</div>
                    <div class="empty-sub">Попробуйте другой запрос</div>
                </div>` : list.map(server => {
                    const active = server.id === this.S.activeServer ? 'active' : '';
                    // server.unread is never populated by the backend — the real
                    // per-channel counts live in S.channelUnread, so sum those up
                    // for the aggregate badge instead of reading a field that's
                    // always undefined.
                    const serverUnreadCount = (server.channels || []).reduce(
                        (sum, ch) => sum + Number(this.S.channelUnread?.[`${server.id}:${ch.id}`] || 0),
                        0
                    );
                    const badge = serverUnreadCount > 0
                        ? `<div class="badge server-badge">${serverUnreadCount > 99 ? '99+' : serverUnreadCount}</div>`
                        : '';
                    const preview = server.description || server.hint || 'Сервер';
                    return `
                        <button class="server-item ${active}" type="button" data-server-id="${this.esc(server.id)}" title="${this.esc(server.name)}" aria-label="${this.esc(server.name)}">
                            <span class="server-avatar" style="background:${this.safeCssColor(server.color) || 'linear-gradient(180deg, #cbff00, #8c8c8c)'}">${this.esc(server.icon || server.name?.[0] || 'S')}</span>
                            <div class="server-meta">
                                <div class="server-name">${this.esc(server.name)}</div>
                                <div class="server-prev">${this.esc(preview)}</div>
                            </div>
                            ${badge}
                        </button>
                    `;
                }).join('')}
                ${createTile}
                ${joinTile}
                ${publicTile}
            </div>
        `;
    }

    updateServerSelection() {
        const rows = document.querySelectorAll('.server-item[data-server-id]');
        rows.forEach(row => {
            const serverId = row.getAttribute('data-server-id');
            row.classList.toggle('active', serverId === this.S.activeServer);
        });
    }

    setActiveServer(serverId, { persist = true } = {}) {
        const next = String(serverId || '').trim();
        if (!next) return;
        this.ensureServersState();
        if (!this.S.servers.some(server => server.id === next)) return;
        const previousVoiceServer = String(this.voice.serverId || '').trim();
        const previousVoiceChannel = String(this.voice.channelId || '').trim();
        const current = this.currentServer();
        const currentChannel = this.currentChannel();
        if (this.S.navMode === 'servers' && this.S.activeServer === next && current && currentChannel) return;
        this.S.activeServer = next;
        this.S.activeConversationType = 'servers';
        this.S.navMode = 'servers';
        const server = this.currentServer();
        if (server) {
            const storedChannel = this.loadStoredActiveChannel();
            const fallbackChannel = (server.channels || [])[0]?.id || null;
            this.S.activeChannel = storedChannel && (server.channels || []).some(ch => ch.id === storedChannel)
                ? storedChannel
                : fallbackChannel;
        }
        if (persist) {
            this.saveStoredNavMode('servers');
            this.saveStoredActiveServer(next);
            this.saveStoredActiveChannel(this.S.activeChannel);
        }
        if (this.voice.roomType === 'channel' && previousVoiceServer && previousVoiceChannel) {
            const nextVoiceChannel = String(this.S.activeChannel || '').trim();
            if (previousVoiceServer !== next || previousVoiceChannel !== nextVoiceChannel) {
                this.leaveVoiceRoom({ announce: true });
            }
        }
        this.updateNavModeButtons();
        this.renderServerToolbar();
        this.requestMessagesScroll('bottom');
        this.resetMessageWindow();
        this.scheduleRenderMessages();
        this.updateSendButtonState();
        this.updateServerSelection();
        if (this.S.activeServer && this.S.activeChannel) {
            this.requestMessagesScroll('bottom');
            this.loadServerMessages(this.S.activeServer, this.S.activeChannel, { silent: true });
        }
        this.closeMobileSidebar();
        this.syncMobileChrome();
    }

    getCurrentMessages() {
        if (this.S.navMode === 'servers') {
            const key = this.currentServerChatKey();
            return this.S.serverChats[key] || [];
        }
        return this.S.chats[this.S.current] || [];
    }

    ensureConversationLoaded(peer = null) {
        const currentPeer = String(peer || this.S.current || '').trim();
        if (!currentPeer) return false;
        const currentMsgs = this.S.chats[currentPeer];
        if (Array.isArray(currentMsgs) && currentMsgs.length > 0) {
            return true;
        }

        const cache = this.loadStoredMessageCache();
        const cachedMsgs = Array.isArray(cache?.chats?.[currentPeer]) ? cache.chats[currentPeer] : [];
        if (cachedMsgs.length === 0) return false;

        this.S.chats[currentPeer] = cachedMsgs.filter(msg => msg && typeof msg === 'object');
        this.trace(`ensureConversationLoaded peer=${currentPeer} restored=${this.S.chats[currentPeer].length}`);
        return true;
    }

    scheduleRenderMessages() {
        if (this.messageRenderRaf) return;
        this.messageRenderRaf = requestAnimationFrame(() => {
            this.messageRenderRaf = 0;
            this._renderMessagesNow();
        });
    }

    renderMessages() {
        this.scheduleRenderMessages();
    }

    _renderMessagesNow() {
        const box = document.getElementById('msgs');
        if (!box) return;
        this.hideReactionMenu();
        const isServers = this.S.navMode === 'servers';
        const conversationKey = isServers ? this.currentServerChatKey() : String(this.S.current || '').trim();
        const previousConversationKey = this.lastRenderedConversationKey || '';
        const conversationChanged = previousConversationKey !== conversationKey;
        const previousScrollTop = box.scrollTop;
        const previousScrollHeight = box.scrollHeight;
        const stickToBottom = this.isMessagesNearBottom(box);
        const scrollAnchor = this.captureMessageScrollAnchor(box);
        const msgs = this.getCurrentMessages();
        const channel = this.currentChannel();
        const server = this.currentServer();

        if (!isServers && (!Array.isArray(msgs) || msgs.length === 0) && !this.S.loading) {
            const restored = this.ensureConversationLoaded(this.S.current);
            if (restored) {
                this.trace(`renderMessages rerender restored peer=${String(this.S.current || '').trim()}`);
                this.scheduleRenderMessages();
                return;
            }
        }

        if (isServers && channel && this.isVoiceChannel(channel)) {
            box.innerHTML = this.renderVoiceRoomView();
            this.requestMessagesScroll('top');
            this.applyPendingMessagesScroll(box);
            if (isServers && server) {
                const chatHdrAva = document.getElementById('chatHdrAva');
                const chatHdrName = document.getElementById('chatHdrName');
                const chatHdrSub = document.getElementById('chatHdrSub');
                if (chatHdrAva) chatHdrAva.innerHTML = this.esc(server.icon || server.name?.[0] || 'S');
                if (chatHdrName) chatHdrName.innerHTML = `<span class="chat-hdr-title">${this.channelKindIcon('voice', 'chat-hdr-channel-icon')}<span>${this.esc(channel.name)}</span></span><span class="chat-hdr-count">${this.esc(`Голосовой канал`)}</span>`;
                if (chatHdrSub) chatHdrSub.textContent = `${server.name}${channel.topic ? ` · ${channel.topic}` : ''}`;
                this.updateChatHeaderCryptoKey({
                    serverId: server.id,
                    channelId: channel?.id || null,
                });
            }
            this.renderVoicePanel();
            return;
        }

        if (msgs.length === 0 && !this.S.loading) {
            if (isServers) {
                box.innerHTML = `<div class="empty-state">
                    <div class="empty-ttl">Нет сообщений в канале</div>
                    <div class="empty-sub">${channel ? `#${this.esc(channel.name)}` : 'Выберите канал'}</div>
                </div>`;
                return;
            }
            box.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Нет сообщений</div>
                <div class="empty-sub">Начните разговор</div>
            </div>`;
            return;
        }

        const windowInfo = this.computeMessageWindow(msgs, box, {
            conversationChanged,
            stickToBottom,
        });
        const renderedMsgs = windowInfo.useWindow ? msgs.slice(windowInfo.start, windowInfo.end) : msgs;
        let html = '';
        if (windowInfo.useWindow && windowInfo.topSpacer > 0) {
            html += `<div class="msg-window-spacer" aria-hidden="true" style="height:${Math.round(windowInfo.topSpacer)}px"></div>`;
        }
        const GROUP_WINDOW_MS = 5 * 60 * 1000;
        const items = renderedMsgs.map(msg => {
            const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;
            const dayKey = ts ? new Date(ts).toDateString() : '';
            return { msg, ts, dayKey, groupPos: 'single' };
        });

        let activeGroup = null;
        items.forEach((item) => {
            const isGroupable = item.msg?.kind !== 'call' && !!item.ts && !!item.dayKey && !!String(item.msg?.sender || '').trim();
            const sameSender = !!(activeGroup && activeGroup.sender === item.msg.sender);
            const sameDay = !!(activeGroup && activeGroup.dayKey === item.dayKey);
            const withinWindow = !!(activeGroup && item.ts && activeGroup.lastTs && (item.ts - activeGroup.lastTs) <= GROUP_WINDOW_MS);

            if (isGroupable && sameSender && sameDay && withinWindow) {
                item.groupPos = 'end';
                if (activeGroup.items.length === 1) {
                    activeGroup.items[0].groupPos = 'start';
                } else if (activeGroup.items.length > 1) {
                    activeGroup.items[activeGroup.items.length - 1].groupPos = 'mid';
                }
                activeGroup.items.push(item);
                activeGroup.lastTs = item.ts;
                return;
            }

            item.groupPos = 'single';
            if (isGroupable) {
                activeGroup = {
                    sender: String(item.msg.sender || '').trim(),
                    dayKey: item.dayKey,
                    lastTs: item.ts,
                    items: [item],
                };
            } else {
                activeGroup = null;
            }
        });

        let lastDate = null;
        items.forEach(item => {
            const msg = item.msg;
            const isOut = this.isOutgoingMessage(msg);
            const isCall = msg.kind === 'call';
            const dateStr = this.fmtDate(msg.timestamp);
            const mediaCard = !isCall && this.messageHasMedia(msg) ? 'media-card' : '';
            const gifOnly = !isCall && this.messageIsGifOnly(msg);
            const isSending = isOut && msg.status === 'sending';
            const messageId = String(msg.id || '').trim();
            const hoverTimeLabel = !isCall ? this.messageHoverTimeLabel(msg) : '';
            const showInlineTime = !isCall && (item.groupPos === 'single' || item.groupPos === 'end');
            const inlineTimeLabel = !isCall ? this.messageInlineTimeLabel(msg) : '';
            if (dateStr && dateStr !== lastDate) {
                html += `<div class="date-sep"><span>${this.esc(dateStr)}</span></div>`;
                lastDate = dateStr;
            }

            const dir = isCall ? (isOut ? 'out' : 'in') : (isOut ? 'out' : 'in');
            const showAvatar = !isCall && !isOut && (item.groupPos === 'single' || item.groupPos === 'end');
            const bubbleClass = isCall ? '' : (gifOnly ? 'media-only msg-time-anchor' : `bubble ${mediaCard} msg-time-anchor`);

            html += `<div class="msg ${dir} ${isCall ? 'call-msg' : `group-${item.groupPos}`} ${isSending ? 'sending' : ''} ${gifOnly ? 'gif-only' : ''} ${showInlineTime ? 'time-visible' : 'time-hidden'}"${messageId ? ` data-message-id="${this.esc(messageId)}"` : ''}>`;
            if (!isCall && !isOut && showAvatar) {
                html += `<div class="msg-ava">${this.renderAvatarHTML(msg.sender, 'avatar-img', msg.sender)}</div>`;
            } else if (!isCall && !isOut) {
                html += `<div class="msg-ava msg-ava-spacer" aria-hidden="true"></div>`;
            }
            html += `<div class="bwrap ${isCall ? 'call-wrap' : ''}">
                ${isCall ? this.renderMessageBody(msg) : `<div class="${bubbleClass}"${hoverTimeLabel ? ` title="${this.esc(hoverTimeLabel)}"` : ''}>${this.renderMessageBody(msg)}${inlineTimeLabel ? `<span class="msg-time" aria-hidden="true">${this.esc(inlineTimeLabel)}</span>` : ''}</div>`}
                ${!isCall ? this.renderMessageReactions(msg) : ''}
            </div></div>`;
        });

        if (this.S.loading) {
            html += `<div class="sk sk-bubble sk-w2"></div>
                     <div class="sk sk-bubble sk-w3 sk-self"></div>
                     <div class="sk sk-bubble sk-w1"></div>
                     <div class="sk sk-bubble sk-w2 sk-self"></div>`;
        }

        if (windowInfo.useWindow && windowInfo.bottomSpacer > 0) {
            html += `<div class="msg-window-spacer" aria-hidden="true" style="height:${Math.round(windowInfo.bottomSpacer)}px"></div>`;
        }

        box.innerHTML = html;
        this.hydrateGifMedia(box);

        const msgNodes = box.querySelectorAll('.msg');
        if (msgNodes.length) {
            const heights = Array.from(msgNodes).map(node => Number(node.getBoundingClientRect?.().height || node.offsetHeight || 0)).filter(Boolean);
            if (heights.length) {
                const avgHeight = heights.reduce((sum, value) => sum + value, 0) / heights.length;
                const current = Number(this.messageWindow?.avgHeight || 92);
                this.messageWindow.avgHeight = Math.max(56, Math.min(160, current * 0.7 + avgHeight * 0.3));
            }
        }
        this.messageWindow.conversationKey = conversationKey;
        this.messageWindow.start = windowInfo.useWindow ? windowInfo.start : 0;
        this.messageWindow.end = windowInfo.useWindow ? windowInfo.end : msgs.length;
        this.messageWindow.count = msgs.length;
        this.messageWindow.useWindow = !!windowInfo.useWindow;

        const preserveScroll = !conversationChanged && !this.pendingMessagesScroll && !stickToBottom;
        if (preserveScroll && previousScrollHeight > 0) {
            const restored = this.restoreMessageScrollAnchor(box, scrollAnchor);
            if (!restored) {
                const scrollDelta = box.scrollHeight - previousScrollHeight;
                const nextScrollTop = Math.max(0, previousScrollTop + scrollDelta);
                box.scrollTop = nextScrollTop;
            }
        }

        if (this.pendingMessagesScroll === 'top') {
            this.applyPendingMessagesScroll(box);
        } else if (this.pendingMessagesScroll === 'bottom') {
            const shouldAutoScroll = conversationChanged || stickToBottom || previousScrollHeight <= box.clientHeight;
            if (shouldAutoScroll) {
                this.applyPendingMessagesScroll(box);
            } else {
                this.pendingMessagesScroll = null;
            }
        } else if (!conversationChanged && stickToBottom) {
            void box.offsetHeight;
            box.scrollTop = box.scrollHeight;
        }

        if (isServers && server) {
            const chatHdrAva = document.getElementById('chatHdrAva');
            const chatHdrName = document.getElementById('chatHdrName');
            const chatHdrSub = document.getElementById('chatHdrSub');
            if (chatHdrAva) chatHdrAva.innerHTML = this.esc(server.icon || server.name?.[0] || 'S');
            if (chatHdrName) {
                const channelTitle = channel
                    ? `${this.channelKindIcon(channel.kind, 'chat-hdr-channel-icon')}<span>${this.esc(channel.name)}</span>`
                    : this.esc(server.name);
                chatHdrName.innerHTML = `<span class="chat-hdr-title">${channelTitle}</span>`;
            }
            if (chatHdrSub) {
                chatHdrSub.textContent = channel
                    ? `${server.name}${channel.topic ? ` · ${channel.topic}` : ''}`
                    : (server.description || 'Сервер');
            }
        }
        this.lastRenderedConversationKey = conversationKey;
    }

    switchChat(name) {
        const peer = String(name || '').trim();
        if (!peer) return;
        this.trace(`switchChat peer=${peer}`);
        this.clearActiveServerSelection();
        this.S.current = peer;
        this.lastRenderedConversationKey = peer;
        this.S.unread[peer] = 0;
        this.initChat(peer);
        this.ensureConversationCryptoKey({ peer, reason: 'switchChat' });
        this.saveStoredCurrentContact(peer);
        this.requestMessagesScroll('bottom');
        const wasServers = this.S.navMode === 'servers';
        this.setNavMode('dm', { refresh: !wasServers });
        this.resetMessageWindow();

        const set = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
        set('tbChat',       peer);
        set('chatHdrName',  peer);
        this.updateChatHeaderCryptoKey({ peer });
        const chatHdrAva = document.getElementById('chatHdrAva');
        if (chatHdrAva) chatHdrAva.innerHTML = this.renderAvatarHTML(peer, 'avatar-img', peer);
        const chatCallBtn = document.getElementById('chatCallBtn');
        if (chatCallBtn) chatCallBtn.hidden = !this.S.current;
        const serverSettingsBtn = document.getElementById('serverSettingsBtn');
        if (serverSettingsBtn) serverSettingsBtn.hidden = true;

        if (wasServers) {
            this.renderServerInterface();
            this.renderContacts();
            this.scheduleRenderMessages();
            this.renderVoicePanel();
        } else {
            this.renderContacts();
            this.scheduleRenderMessages();
        }
        this.updateSendButtonState();
        this.syncActiveConversation({ force: true });
        this.closeMobileSidebar();
        this.syncMobileChrome();
    }

    async sendInputMessage() {
        const inp = document.getElementById('msgInput');
        const textValue = (inp && inp.value) || '';
        const text = textValue.trim();
        const attachments = this.normalizeAttachments(this.S.draftAttachments);
        if (!text && attachments.length === 0) return;

        const clientId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const payloadAttachments = attachments.map(att => ({ ...att }));
        const ts = new Date().toISOString();
        const activeMode = this.currentConversationMode();
        const isServers = activeMode === 'servers';
        const server = isServers ? this.currentServer() : null;
        const channel = isServers ? this.currentChannel() : null;
        const conversationKey = isServers ? this.currentServerChatKey() : this.S.current;
        if (isServers && (!server || !channel)) return;
        if (isServers && this.isVoiceChannel(channel)) return;
        if (!isServers && !this.S.current) return;
        this.trace(`sendInputMessage context mode=${activeMode} navMode=${this.S.navMode} activeType=${String(this.S.activeConversationType || 'nil')} current=${String(this.S.current || 'nil')} activeServer=${String(this.S.activeServer || 'nil')} activeChannel=${String(this.S.activeChannel || 'nil')} rendered=${String(this.lastRenderedConversationKey || 'nil')} serverKey=${String(this.currentServerChatKey() || 'nil')}`);
        const cryptoKey = await this.resolveConversationCryptoKey({
            peer: isServers ? null : this.S.current,
            serverId: isServers ? server.id : null,
            channelId: isServers ? channel.id : null,
            reason: 'sendInputMessage'
        });
        const keyVersion = 2;
        this.trace(`sendInputMessage start clientId=${clientId} mode=${activeMode} sender=${this.myName()} receiver=${isServers ? channel.id : this.S.current} server=${isServers ? server.id : 'dm'} channel=${isServers ? channel.id : 'dm'} attachments=${payloadAttachments.length} textBytes=${text.length} keySet=${!!cryptoKey} tokenSet=${!!this.S.session?.token}`);

        const outgoingMessage = {
            id: clientId,
            sender: this.myName(),
            receiver: isServers ? channel.id : this.S.current,
            text,
            attachments: payloadAttachments,
            timestamp: ts,
            status: 'sending',
            clientId,
            serverId: isServers ? server.id : null,
            channelId: isServers ? channel.id : null,
            keyVersion,
        };

        if (!this.S.session?.token) {
            this.trace(`sendInputMessage missingToken clientId=${clientId}`);
            this.addLogEntry({ type: 'ERROR', msg: 'Для отправки сообщения нужно войти в аккаунт', ts: new Date().toLocaleTimeString() });
            return;
        }

        // Recover the E2E key from the cloud vault BEFORE giving up. A fresh device
        // (or one whose in-memory key was cleared) can still have a recoverable vault
        // snapshot. This used to live after an early `if (!cryptoKey) return`, which
        // made it dead code — sends failed with "нужен E2E-ключ" even when recovery
        // would have succeeded.
        if (!cryptoKey) {
            const recoveredVaultPassphrase = await this.loadVaultUnlockSecret(this.S.session?.token);
            if (recoveredVaultPassphrase) {
                this.S.auth.vaultPassphrase = recoveredVaultPassphrase;
                await this.restoreCloudVaultSnapshot({ reason: 'sendInputMessage' });
                await this.syncCloudVaultPackage({ passphrase: recoveredVaultPassphrase, reason: 'sendInputMessage' });
            }
        }
        const effectiveCryptoKey = cryptoKey || this.loadStoredCryptoKey();
        if (!effectiveCryptoKey) {
            this.trace(`sendInputMessage missingKey clientId=${clientId}`);
            this.addLogEntry({ type: 'ERROR', msg: 'Для отправки сообщения нужен E2E-ключ', ts: new Date().toLocaleTimeString() });
            return;
        }

        if (!isServers && String(this.S.current || '').trim() !== this.myName()) {
            const scope = this.conversationScopeKey(this.S.current);
            if (!this._publishedKeyScopes) this._publishedKeyScopes = new Set();
            if (!this._publishedKeyScopes.has(scope)) {
                this._publishedKeyScopes.add(scope);
                void this.publishConversationKeyToPeer({
                    peer: this.S.current,
                    scope,
                    key: effectiveCryptoKey,
                    reason: 'sendInputMessage',
                }).then(published => {
                    if (published !== true) {
                        // false = transport/server failure, 'no_devices' = peer has no
                        // registered devices yet. Either way the envelope was not
                        // delivered, so allow a retry on the next send.
                        this._publishedKeyScopes.delete(scope);
                        this.trace(`sendInputMessage keyPublishPending peer=${this.S.current} scope=${scope} result=${published}`);
                        if (published === false) {
                            this.addLogEntry({ type: 'WARN', msg: 'E2E-ключ не доставлен собеседнику, повтор при следующей отправке', ts: new Date().toLocaleTimeString() });
                        }
                    }
                });
            }
        }

        const bridgeAvailable = this.nativeSupports('sendMessage');
        if (!bridgeAvailable) {
            this.trace(`sendInputMessage noNativeBridge clientId=${clientId}`);
            if (isServers) {
                if (!this.S.serverChats[conversationKey]) this.S.serverChats[conversationKey] = [];
                this.S.serverChats[conversationKey].push(outgoingMessage);
            } else {
                this.ensureContact(this.S.current);
                this.initChat(this.S.current);
                this.S.chats[this.S.current].push(outgoingMessage);
            }
            this.saveStoredMessageCache();
            this.scheduleRenderMessages();
            this.renderContacts();
            this.renderServerInterface();
            if (inp) {
                inp.value = '';
                this.resizeComposer();
            }
            this.clearDraftAttachments();
            this.updateSendButtonState();
            inp && inp.focus();

            // No native shell (macOS/Windows) around this WebView — we're running as a
            // plain browser tab. Pack the .zali archive ourselves via the WASM build of
            // core/ (see web/src/modules/wasm_bridge.js) and upload it straight to the
            // server over fetch, instead of just stranding the message locally.
            const sent = await this.browserSendMessage({
                text,
                key: effectiveCryptoKey,
                keyVersion,
                sender: this.myName(),
                receiver: isServers ? channel.id : this.S.current,
                serverId: isServers ? server.id : '',
                channelId: isServers ? channel.id : '',
                clientId,
                attachments: payloadAttachments,
            }).catch(error => {
                this.trace(`sendInputMessage browserSendMessage error clientId=${clientId} error=${error?.message || error}`);
                return false;
            });
            if (sent) {
                this.trace(`sendInputMessage browserSendMessage ok clientId=${clientId}`);
                this.addLogEntry({ type: 'SUCCESS', msg: 'Отправлено из браузера (WASM)', ts: new Date().toLocaleTimeString() });
            } else {
                this.addLogEntry({ type: 'WARN', msg: 'Не удалось отправить сообщение из браузера. Сообщение сохранено только в локальном интерфейсе.', ts: new Date().toLocaleTimeString() });
            }
            return;
        }

        if (isServers) {
            if (!this.S.serverChats[conversationKey]) this.S.serverChats[conversationKey] = [];
            this.S.serverChats[conversationKey].push(outgoingMessage);
        } else {
            this.ensureContact(this.S.current);
            this.initChat(this.S.current);
            this.S.chats[this.S.current].push(outgoingMessage);
        }
        this.saveStoredMessageCache();

        this.scheduleRenderMessages();
        this.renderContacts();
        this.renderServerInterface();

        if (inp) {
            inp.value = '';
            this.resizeComposer();
        }

        this.clearDraftAttachments();
        this.updateSendButtonState();
        inp && inp.focus();

        this.cachePendingOutboxAttachments(clientId, payloadAttachments);
        this.enqueuePendingOutbox({
            ...outgoingMessage,
            key: effectiveCryptoKey,
            keyVersion,
            attemptCount: 1,
            lastAttemptAt: Date.now(),
            nextRetryAt: Date.now() + 20000,
            inFlight: true,
        });
        this.scheduleSendWatchdog(outgoingMessage, effectiveCryptoKey);
        this.trace(`sendInputMessage queued clientId=${clientId}`);

        const sentToNative = this.postNativeMessage({
            type: NativeMessageTypes.SEND_MESSAGE,
            text: text,
            recipient: isServers ? channel.id : this.S.current,
            serverId: isServers ? server.id : '',
            channelId: isServers ? channel.id : '',
            sender: this.myName(),
            key: effectiveCryptoKey,
            keyVersion,
            clientId,
            attachments: payloadAttachments.map(att => ({
                name: att.name,
                mimeType: att.mimeType,
                kind: att.kind,
                size: att.size,
                dataUrl: att.dataUrl,
            }))
        });
        if (!sentToNative) {
            this.trace(`sendInputMessage native bridge rejected clientId=${clientId}`);
            this.updatePendingOutboxItem(clientId, {
                inFlight: false,
                nextRetryAt: Date.now() + 1000,
            });
            this.addLogEntry({ type: 'WARN', msg: 'Native bridge не принял сообщение, оставлено в очереди повтора', ts: new Date().toLocaleTimeString() });
            this.scheduleFlushPendingOutbox(1000);
        }
    }

    // --- Browser-only (no native shell) send/receive path, backed by the WASM build
    // of core/ (web/src/modules/wasm_bridge.js packs/unpacks the .zali archive format
    // entirely in-browser — same wire format as the native macOS/Windows clients use).

    async wasmAvailable() {
        return !!(window.ZaliWasm && await window.ZaliWasm.isAvailable());
    }

    async dataUrlToBytes(dataUrl) {
        const res = await fetch(dataUrl);
        const buf = await res.arrayBuffer();
        return new Uint8Array(buf);
    }

    async browserSendMessage({ text, key, keyVersion, sender, receiver, serverId, channelId, clientId, attachments }) {
        if (!key || !receiver) return false;
        if (!(await this.wasmAvailable())) return false;

        const wasmAttachments = [];
        for (const att of (attachments || [])) {
            if (!att?.dataUrl) continue;
            try {
                const bytes = await this.dataUrlToBytes(att.dataUrl);
                wasmAttachments.push({
                    name: att.name || 'attachment',
                    archivePath: `attachments/${att.name || 'attachment'}`,
                    mimeType: att.mimeType || 'application/octet-stream',
                    kind: att.kind || 'file',
                    bytes,
                });
            } catch (e) {
                this.trace(`browserSendMessage attachment decode failed name=${att?.name} error=${e?.message || e}`);
            }
        }

        const archiveBytes = await window.ZaliWasm.packMessage(sender, text, key, keyVersion, wasmAttachments);
        if (!archiveBytes || !archiveBytes.length) return false;

        const formData = new FormData();
        formData.append('sender', sender || '');
        formData.append('receiver', receiver);
        if (serverId) formData.append('server_id', serverId);
        if (channelId) formData.append('channel_id', channelId);
        if (clientId) formData.append('client_id', clientId);
        formData.append('key_version', String(keyVersion || ''));
        formData.append('file', new Blob([archiveBytes], { type: 'application/octet-stream' }), 'message.zali');

        const res = await this.apiFetch(this.apiRoutes.messages.upload, {
            method: 'POST',
            body: formData,
        });
        return res.ok;
    }

    // Handles a raw `Message` row pushed over the WS connection (no `type` field —
    // see server/src/realtime.rs deliver_to_user/deliver_server_message). Downloads
    // the .zali archive and decrypts it in-browser via WASM, then feeds the result
    // into the same receiveMessage() path the native shells use.
    async handleIncomingBrowserMessage(payload) {
        const id = String(payload?.id || '').trim();
        const sender = String(payload?.sender || '').trim();
        const receiver = String(payload?.receiver || '').trim();
        if (!id || !sender || !receiver) return;
        if (!(await this.wasmAvailable())) return;

        const serverId = payload?.server_id || null;
        const channelId = payload?.channel_id || null;
        const peer = sender === this.myName() ? receiver : sender;

        let key = this.ensureConversationCryptoKey({
            peer: serverId ? null : peer,
            serverId,
            channelId,
            reason: 'handleIncomingBrowserMessage',
        });
        for (let attempt = 0; !key && attempt < 5; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 400));
            key = await this.resolveConversationCryptoKey({
                peer: serverId ? null : peer,
                serverId,
                channelId,
                reason: 'handleIncomingBrowserMessage',
            });
        }
        if (!key) {
            this.trace(`handleIncomingBrowserMessage missingKey id=${id} peer=${peer}`);
            return;
        }

        try {
            const res = await this.apiFetch(this.apiRoutes.messages.download(id));
            if (!res.ok) return;
            const archiveBytes = new Uint8Array(await res.arrayBuffer());
            const unpacked = await window.ZaliWasm.unpackMessage(archiveBytes, key);
            const attachments = (unpacked.attachments || []).map(att => ({
                name: att.name,
                mimeType: att.mimeType,
                kind: att.kind,
                size: att.bytes?.length || 0,
                dataUrl: att.bytes?.length
                    ? URL.createObjectURL(new Blob([att.bytes], { type: att.mimeType || 'application/octet-stream' }))
                    : '',
                archivePath: att.archivePath,
            }));
            this.bus.send('zali_interface:receive_message', {
                id,
                clientId: payload?.client_id || '',
                sender: unpacked.sender || sender,
                receiver,
                text: unpacked.text,
                timestamp: unpacked.timestamp ? unpacked.timestamp * 1000 : payload?.timestamp,
                attachments,
                reactions: payload?.reactions || [],
                myReaction: payload?.myReaction || payload?.my_reaction || '',
                serverId,
                channelId,
            });
        } catch (e) {
            this.trace(`handleIncomingBrowserMessage failed id=${id} error=${e?.message || e}`);
        }
    }

    // Fallback for loading DM history from a plain browser tab (no native shell to do
    // it via REFRESH_HISTORY). Downloads + decrypts each message metadata row returned
    // by GET /api/messages/:user and feeds it through receiveMessage(), same as above.
    async loadBrowserDmHistory(peer, key) {
        if (!peer || !key) return;
        if (!(await this.wasmAvailable())) return;
        try {
            const res = await this.apiFetch(this.apiRoutes.messages.direct(peer));
            if (!res.ok) return;
            const rows = await res.json();
            if (!Array.isArray(rows)) return;
            for (const row of rows) {
                await this.handleIncomingBrowserMessage(row);
            }
        } catch (e) {
            this.trace(`loadBrowserDmHistory failed peer=${peer} error=${e?.message || e}`);
        }
    }

    _getKey() {
        try {
            return this.ensureConversationCryptoKey({
                peer: this.currentConversationMode() === 'servers' ? null : this.S.current,
                serverId: this.currentConversationMode() === 'servers' ? this.currentServer()?.id || null : null,
                channelId: this.currentConversationMode() === 'servers' ? this.currentChannel()?.id || null : null,
                reason: '_getKey'
            });
        } catch (e) {
            return '';
        }
    }

    updateSendButtonState() {
        const btn = document.getElementById('sendBtn');
        const inp = document.getElementById('msgInput');
        const hasText = !!(inp && inp.value.trim().length);
        const hasAttachments = this.S.draftAttachments.length > 0;
        const channel = this.currentChannel();
        const canSend = this.currentConversationMode() === 'servers'
            ? !!(this.currentServer() && channel && !this.isVoiceChannel(channel))
            : !!this.S.current;
        if (btn) btn.disabled = !(hasText || hasAttachments) || !canSend;
    }

    // --- Bus Command Handlers ---

    receiveMessage(payload = {}) {
        const {
            id,
            sender,
            receiver,
            text,
            timestamp,
            attachments,
            reactions,
            myReaction,
        } = payload || {};
        const serverId = payload?.serverId || payload?.server_id || null;
        const channelId = payload?.channelId || payload?.channel_id || null;
        const clientId = String(payload?.clientId || payload?.client_id || '').trim();
        this.trace(`receiveMessage id=${String(id || '').trim()} clientId=${clientId || 'none'} sender=${String(sender || '').trim()} receiver=${String(receiver || '').trim()} server=${serverId || 'dm'} channel=${channelId || 'dm'} textBytes=${String(text || '').length} attachments=${Array.isArray(attachments) ? attachments.length : 0} reactions=${Array.isArray(reactions) ? reactions.length : 0}`);
        if (clientId) {
            const reconciled = this.finalizePendingMessage(clientId, id);
            if (reconciled) {
                this.dropPendingOutbox(clientId);
                if (serverId && channelId) {
                    this.renderServerInterface();
                } else {
                    this.scheduleRenderMessages();
                    this.renderContacts();
                }
                this.addLogEntry({ type: 'SUCCESS', msg: `Сообщение подтверждено сервером: ${sender}`, ts: new Date().toLocaleTimeString() });
                return;
            }
        }
        if (serverId && channelId) {
            const key = `${serverId}:${channelId}`;
            const msgs = this.S.serverChats[key] || (this.S.serverChats[key] = []);
            const incomingAttachments = this.normalizeAttachments(attachments);
            const incomingReactions = this.normalizeReactions(reactions);
            const incomingText = this.sanitizeDecryptionErrorText(text);
            const messageId = String(id || '').trim();
            const attachmentKey = incomingAttachments.map(att => `${att.name}:${att.kind}:${att.size}`).join('|');
            const ts = timestamp || new Date().toISOString();
            const existingIndex = messageId
                ? msgs.findIndex(m => String(m.id || '').trim() === messageId)
                : msgs.findIndex(m =>
                    m.sender === sender &&
                    m.text === incomingText &&
                    this.normalizeAttachments(m.attachments).map(att => `${att.name}:${att.kind}:${att.size}`).join('|') === attachmentKey
                );
            if (existingIndex >= 0) {
                const prev = msgs[existingIndex];
                msgs[existingIndex] = {
                    ...prev,
                    id: messageId || prev.id || '',
                    clientId: clientId || prev.clientId || '',
                    sender: sender || prev.sender || '',
                    receiver: receiver || prev.receiver || '',
                    text: incomingText || prev.text || '',
                    attachments: incomingAttachments.length ? incomingAttachments : this.normalizeAttachments(prev.attachments),
                    reactions: incomingReactions.length ? incomingReactions : this.normalizeReactions(prev.reactions),
                    myReaction: String(myReaction || prev.myReaction || '').trim(),
                    timestamp: ts || prev.timestamp || new Date().toISOString(),
                    serverId: serverId || prev.serverId || '',
                    channelId: channelId || prev.channelId || '',
                };
            } else {
                msgs.push({
                    id: messageId,
                    clientId,
                    sender,
                    receiver,
                    text: incomingText,
                    attachments: incomingAttachments,
                    reactions: incomingReactions,
                    myReaction: myReaction || '',
                    timestamp: ts,
                    serverId,
                    channelId,
                });
                // "Visible" requires both the matching channel AND the servers view being
                // active — currentServerChatKey() keeps returning the selected channel
                // even while the user is looking at DMs, which used to swallow the
                // notification for messages arriving in that channel.
                const channelVisible = this.isServerChatVisible(key);
                if (!channelVisible) {
                    this.notifyBackgroundMessage({ sender, text: incomingText, attachmentCount: incomingAttachments.length, serverId, channelId });
                }
            }
            this.scheduleSaveStoredMessageCache();
            // Only render the channel's message list when it is actually the visible view.
            // currentServerChatKey() still returns the selected channel while the user is
            // in the DM view, so rendering on that alone painted channel messages into the
            // DM pane (and wasted work). Mirror the notification-visibility check above.
            if (this.isServerChatVisible(key)) {
                this.scheduleRenderMessages();
            } else {
                this.renderServerInterface();
                this.renderContacts();
            }
            this.scheduleConversationRefresh({
                serverId,
                channelId,
                reason: 'receiveMessageServer',
            });
            this.addLogEntry({ type: 'SUCCESS', msg: `Получено в канале ${serverId}/${channelId}: ${sender}`, ts: new Date().toLocaleTimeString() });
            return;
        }

        const peer = sender === this.myName() ? receiver : sender;
        this.ensureContact(peer);
        this.initChat(peer);
        const msgs = this.S.chats[peer];
        const incomingAttachments = this.normalizeAttachments(attachments);
        const incomingReactions = this.normalizeReactions(reactions);
        const incomingText = this.sanitizeDecryptionErrorText(text);
        const messageId = String(id || '').trim();
        const attachmentKey = incomingAttachments.map(att => `${att.name}:${att.kind}:${att.size}`).join('|');
        const ts = timestamp || new Date().toISOString();
        const existingIndex = messageId
            ? msgs.findIndex(m => String(m.id || '').trim() === messageId)
            : msgs.findIndex(m =>
                m.sender === sender &&
                m.text === incomingText &&
                this.normalizeAttachments(m.attachments).map(att => `${att.name}:${att.kind}:${att.size}`).join('|') === attachmentKey
            );
        if (existingIndex >= 0) {
            const prev = msgs[existingIndex];
            msgs[existingIndex] = {
                ...prev,
                id: messageId || prev.id || '',
                clientId: clientId || prev.clientId || '',
                sender: sender || prev.sender || '',
                receiver: receiver || prev.receiver || '',
                text: incomingText || prev.text || '',
                attachments: incomingAttachments.length ? incomingAttachments : this.normalizeAttachments(prev.attachments),
                reactions: incomingReactions.length ? incomingReactions : this.normalizeReactions(prev.reactions),
                myReaction: String(myReaction || prev.myReaction || '').trim(),
                timestamp: ts || prev.timestamp || new Date().toISOString(),
            };
        } else {
            msgs.push({
                id: messageId,
                clientId,
                sender,
                receiver,
                text: incomingText,
                attachments: incomingAttachments,
                reactions: incomingReactions,
                myReaction: myReaction || '',
                timestamp: ts
            });
            // A DM is only truly visible when its chat is selected AND the DM view is
            // active — while the user is in the servers view the selected DM peer is
            // off-screen, and this notification used to be swallowed for it.
            const dmVisible = this.isDmChatVisible(peer);
            if (!dmVisible) {
                this.notifyBackgroundMessage({ sender, text: incomingText, attachmentCount: incomingAttachments.length, peer });
            }
        }
        this.scheduleSaveStoredMessageCache();
        if (!this.S.current) {
            this.switchChat(peer);
        }
        if (this.isDmChatVisible(peer)) {
            this.scheduleRenderMessages();
        } else {
            // Unread/notification bookkeeping (own-echo filtering included) already
            // happened above via notifyBackgroundMessage; just refresh the sidebar.
            this.renderContacts();
        }
        this.addLogEntry({ type: 'SUCCESS', msg: `Получено: ${sender} → ${receiver}`, ts: new Date().toLocaleTimeString() });
    }

    handleAvatarUpdated({ username, deleted = false } = {}) {
        const name = String(username || '').trim();
        if (!name) return;

        if (deleted) {
            this.saveStoredAvatar(name, null);
        } else {
            this.clearStoredAvatar(name);
            this.ensureAvatarLoaded(name, { force: true });
        }

        this.scheduleAvatarRefresh();
    }

    // Single source of truth for "is this conversation currently on screen". The
    // notification-suppression, render, and unread-clear paths must all agree on this;
    // spelling it out inline at each site is how they drifted apart before.
    isServerChatVisible(key) {
        return this.currentServerChatKey() === key && this.S.navMode === 'servers';
    }

    isDmChatVisible(peer) {
        return !!peer && peer === this.S.current && this.S.navMode !== 'servers';
    }

    isPeerMuted(peer) {
        return !!(this.S.mutedChats || {})[String(peer || '').trim()];
    }

    isChannelMuted(serverId, channelId) {
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        if (!sid || !cid) return false;
        return !!(this.S.mutedChats || {})[`${sid}:${cid}`];
    }

    toggleMutePeer(peer) {
        const key = String(peer || '').trim();
        if (!key) return;
        this.S.mutedChats = this.S.mutedChats || {};
        if (this.S.mutedChats[key]) {
            delete this.S.mutedChats[key];
        } else {
            this.S.mutedChats[key] = true;
        }
        this.saveStoredMutedChats();
        this.renderContacts();
    }

    toggleMuteChannel(serverId, channelId) {
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        if (!sid || !cid) return;
        const key = `${sid}:${cid}`;
        this.S.mutedChats = this.S.mutedChats || {};
        if (this.S.mutedChats[key]) {
            delete this.S.mutedChats[key];
        } else {
            this.S.mutedChats[key] = true;
        }
        this.saveStoredMutedChats();
        this.renderServerInterface();
        this.renderContacts();
    }

    // Single choke point for "a message arrived in a chat the user isn't currently
    // looking at". Both the live WS push path AND the reconnect / background
    // history-catch-up paths (loadHistory, mergeServerChatMessages) route through
    // here — those catch-up paths used to update S.chats/S.serverChats silently with
    // no notification and no unread badge, which was the root cause of notifications
    // being rare and arriving with a huge delay: most messages land via catch-up
    // after a WS drop, not via the live push that used to be the only notify trigger.
    notifyBackgroundMessage({ sender, text, attachmentCount = 0, serverId = null, channelId = null, peer = null }) {
        const from = String(sender || '').trim();
        if (!from || from === this.myName()) return;
        const isChannel = !!(serverId && channelId);
        const muteKey = isChannel ? `${serverId}:${channelId}` : String(peer || '').trim();
        if (!muteKey) return;
        if (isChannel) {
            this.S.channelUnread = this.S.channelUnread || {};
            this.S.channelUnread[muteKey] = (this.S.channelUnread[muteKey] || 0) + 1;
        } else {
            this.S.unread[muteKey] = (this.S.unread[muteKey] || 0) + 1;
        }
        if ((this.S.mutedChats || {})[muteKey]) return;
        this.postNativeMessage({
            type: NativeMessageTypes.SHOW_NOTIFICATION,
            sender: from,
            text,
            attachmentCount,
            serverId: serverId || null,
            channelId: channelId || null,
        });
    }

    // The set of statuses that mean "a call is live and must not be clobbered". Both the
    // incoming-invite busy-guard and the foreign-room-state guard key off this exact set;
    // inlining it twice risks one copy going stale and silently re-opening the
    // active-call-clobber bug.
    isInActiveCall(status = this.voice?.status) {
        return ['connected', 'connecting', 'calling', 'incoming'].includes(String(status || ''));
    }

    setUsers(users) {
        this.S.users = Array.isArray(users) ? users : [];
        this.S.users.forEach(contact => this.initChat(contact));
        const others = this.S.users.filter(contact => contact !== this.myName());
        if (this.S.navMode !== 'servers' && !this.S.current && this.S.contacts.length > 0) this.switchChat(this.S.contacts[0]);
        this.trace(`setUsers count=${this.S.users.length} others=${others.join(',')}`);
        this.addLogEntry({ type: 'INFO', msg: `Загружен список пользователей: ${others.join(', ')}`, ts: new Date().toLocaleTimeString() });
        this.renderContactSuggestions();
    }

    setContacts(contacts) {
        const me = this.myName();
        const remoteContacts = Array.isArray(contacts) ? contacts.filter(Boolean) : [];
        const localContacts = this.localConversationContacts();
        this.S.contacts = Array.from(new Set([...remoteContacts, ...localContacts]))
            .filter(contact => contact !== me);
        this.saveStoredContacts(this.S.contacts);
        this.S.contacts.forEach(contact => this.initChat(contact));
        this.trace(`setContacts count=${this.S.contacts.length} me=${me} contacts=${this.S.contacts.join(',')}`);
        if (this.S.navMode !== 'servers') {
            const storedCurrent = this.loadStoredCurrentContact();
            const currentValid = !!(this.S.current && this.S.contacts.includes(this.S.current));
            const storedValid = !!(storedCurrent && this.S.contacts.includes(storedCurrent));

            if (storedValid && (!currentValid || this.S.current !== storedCurrent)) {
                this.switchChat(storedCurrent);
            } else if (currentValid) {
                this.scheduleRenderMessages();
                this.renderContacts();
            } else if (this.S.contacts.length > 0) {
                this.switchChat(this.S.contacts[0]);
            } else {
                this.S.current = null;
                this.saveStoredCurrentContact(null);
                const set = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
                set('tbChat', 'Нет контактов');
                // Render the user's own avatar here (same as renderServerToolbar's empty
                // state) rather than hard-coding the fallback letter — otherwise this
                // clobbers the just-loaded avatar image and it flashes then disappears.
                const avaEl = document.getElementById('chatHdrAva');
                if (avaEl) avaEl.innerHTML = this.renderAvatarHTML(this.myName(), 'avatar-img', this.myName());
                set('chatHdrName', 'Добавьте контакт');
            }
            if (this.S.current) {
                this.ensureConversationCryptoKey({ peer: this.S.current, reason: 'setContacts' });
                this.syncActiveConversation({ force: true });
            }
        }
        this.renderContacts();
        this.scheduleRenderMessages();
        this.renderContactSuggestions();
    }

    setSession(session) {
        if (!session || typeof session !== 'object') return;
        this.applySession({
            username: session.username || '',
            token: session.token || null,
            guest: !!session.guest || !session.token,
        }, { persist: false, syncNative: false });
        this.loadContacts();
        this.loadUsers();
        this.loadServers({ silent: true });
        this.renderContactSuggestions();
        this.refreshAfterKey();
    }

    loadHistory(messages) {
        const queue = Array.isArray(messages) ? messages.filter(msg => msg && typeof msg === 'object') : [];
        const seq = ++this.historyLoadSeq;
        const sidebarBefore = this.dmSidebarSignature();
        const activeMessagesBefore = this.activeMessagesSignature();
        const currentBefore = this.S.current;
        this.trace(`loadHistory count=${queue.length}`);
        this.addLogEntry({ type: 'INFO', msg: `Загрузка истории чата: ${queue.length} сообщений`, ts: new Date().toLocaleTimeString() });
        const touchedPeers = new Set();
        // Snapshot taken once for the whole call (not re-checked per message): a
        // peer's first-ever loadHistory batch can span many messages across several
        // requestAnimationFrame slices, and re-checking _historyPrimedPeers per
        // message would treat everything after the first message of a brand new
        // peer as "already primed" and notify for the rest of that same initial load.
        const peersPrimedBeforeThisCall = new Set(this._historyPrimedPeers);
        const processBatch = (startIndex = 0) => {
            if (seq !== this.historyLoadSeq) {
                this.trace(`loadHistory stale seq=${seq} current=${this.historyLoadSeq}`);
                return;
            }
            const startedAt = performance.now();
            let index = startIndex;
            for (; index < queue.length; index += 1) {
                if ((index - startIndex) >= 120) break;
                if ((performance.now() - startedAt) >= 8) break;
                const msg = queue[index];
                const peer = msg.kind === 'call'
                    ? String(msg.call?.peer || msg.receiver || msg.sender || '').trim()
                    : (msg.sender === this.myName() ? msg.receiver : msg.sender);
                if (!peer) continue;
                touchedPeers.add(peer);
                const peerAlreadyPrimed = peersPrimedBeforeThisCall.has(peer);
                this._historyPrimedPeers.add(peer);
                this.ensureContact(peer);
                this.initChat(peer);
                const arr = this.S.chats[peer];
                const normalizedAttachments = this.normalizeAttachments(msg.attachments);
                const normalizedReactions = this.normalizeReactions(msg.reactions);
                const msgId = String(msg.id || '').trim();
                const clientId = String(msg.clientId || msg.client_id || '').trim();
                if (clientId && this.finalizePendingMessage(clientId, msgId, { render: false })) {
                    this.dropPendingOutbox(clientId);
                    this.markMessageSeen(msg);
                    continue;
                }
                const incoming = {
                    ...msg,
                    attachments: normalizedAttachments,
                    reactions: normalizedReactions,
                    myReaction: msg.myReaction || '',
                    text: this.sanitizeDecryptionErrorText(msg.text),
                };
                const incomingKey = this.messageRenderKey(incoming);
                const existingIndex = msgId
                    ? arr.findIndex(m => String(m.id || '').trim() === msgId)
                    : arr.findIndex(m => this.messageRenderKey(m) === incomingKey);
                if (existingIndex >= 0) {
                    const prev = arr[existingIndex];
                    arr[existingIndex] = {
                        ...prev,
                        ...msg,
                        id: msgId || msg.id || prev.id || '',
                        attachments: normalizedAttachments.length ? normalizedAttachments : this.normalizeAttachments(prev.attachments),
                        reactions: normalizedReactions.length ? normalizedReactions : this.normalizeReactions(prev.reactions),
                        myReaction: msg.myReaction || prev.myReaction || '',
                        text: this.sanitizeDecryptionErrorText(msg.text) || prev.text || '',
                        status: 'sent'
                    };
                } else {
                    arr.push({
                        ...msg,
                        id: msgId || msg.id || '',
                        attachments: normalizedAttachments,
                        reactions: normalizedReactions,
                        myReaction: msg.myReaction || '',
                        text: this.sanitizeDecryptionErrorText(msg.text),
                        status: 'sent'
                    });
                    // Catch-up sweeps (reconnect, background contact refresh) land here
                    // too, not just the live WS push — this is the root fix for
                    // notifications that used to silently vanish whenever a message
                    // arrived while the socket was down. Skip the peer's very first
                    // sync this session (peerAlreadyPrimed=false) so opening a chat
                    // with existing history doesn't replay it as a notification flood.
                    if (peerAlreadyPrimed && msg.kind !== 'call' && !this.isDmChatVisible(peer)) {
                        this.notifyBackgroundMessage({
                            sender: msg.sender,
                            text: this.sanitizeDecryptionErrorText(msg.text),
                            attachmentCount: normalizedAttachments.length,
                            peer,
                        });
                    }
                }
                this.markMessageSeen(msg);
            }
            if (index < queue.length) {
                requestAnimationFrame(() => processBatch(index));
                return;
            }
            touchedPeers.forEach(peer => {
                const arr = this.S.chats[peer];
                if (Array.isArray(arr)) {
                    arr.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
                }
            });
            this.normalizeDmChatStore();
            this.saveStoredMessageCache();
            if (this.S.navMode !== 'servers') {
                const storedCurrent = this.loadStoredCurrentContact();
                const pendingPeers = this.loadPendingOutbox()
                    .filter(item => String(item?.sender || '').trim() === this.myName())
                    .map(item => String(item?.receiver || '').trim())
                    .filter(Boolean);
                const preferredPeer = (() => {
                    if (storedCurrent && (this.S.chats[storedCurrent] || []).length) return storedCurrent;
                    for (let i = pendingPeers.length - 1; i >= 0; i -= 1) {
                        const peer = pendingPeers[i];
                        if ((this.S.chats[peer] || []).length) return peer;
                    }
                    const populated = Object.entries(this.S.chats)
                        .filter(([, msgs]) => Array.isArray(msgs) && msgs.length > 0)
                        .sort((a, b) => new Date(b[1][b[1].length - 1]?.timestamp || 0) - new Date(a[1][a[1].length - 1]?.timestamp || 0));
                    return populated[0]?.[0] || null;
                })();

                if (!this.S.current && preferredPeer && preferredPeer !== this.S.current) {
                    this.switchChat(preferredPeer);
                }
            }
            const sidebarAfter = this.dmSidebarSignature();
            const activeMessagesAfter = this.activeMessagesSignature();
            const currentChanged = currentBefore !== this.S.current;
            const sidebarChanged = sidebarBefore !== sidebarAfter;
            const activeMessagesChanged = activeMessagesBefore !== activeMessagesAfter || currentChanged;
            if (activeMessagesChanged) {
                this.scheduleRenderMessages();
            }
            if (sidebarChanged) {
                this.renderContacts();
            }
            if (!this.S.current && this.S.contacts.length > 0) {
                this.switchChat(this.S.contacts[0]);
            }
            this.scheduleFlushPendingOutbox(300);
            this.trace(`loadHistory done current=${this.S.current || 'none'} chats=${Object.keys(this.S.chats).length}`);
        };
        processBatch(0);
    }

    setLoading(on) {
        this.S.loading = !!on;
        this.scheduleRenderMessages();
    }

    setConnectionStatus(connected) {
        const wasOn = !!this.S.wsOn;
        this.S.wsOn = !!connected;
        const pill = document.getElementById('wsPill');
        const lbl  = document.getElementById('wsLabel');
        if (pill) pill.className = 'ws-pill' + (connected ? ' on' : '');
        if (lbl)  lbl.textContent = connected ? 'Подключено' : 'Переподключение...';
        this.addLogEntry({ type: connected ? 'SUCCESS' : 'WARN', msg: connected ? 'WebSocket соединение установлено' : 'WebSocket соединение разорвано', ts: new Date().toLocaleTimeString() });
        if (connected) {
            // Connection (re)established — drain the outbox immediately instead of
            // waiting out each message's retry backoff (which grows up to 30s). This
            // was the cause of the long send delay after an account switch / blip.
            this.kickPendingOutboxNow('reconnect');
            // The server only PUSHES messages in real time; anything that arrived
            // while we were offline is never re-sent. So on (re)connect we must pull
            // the active conversation to catch up — otherwise a message sent while the
            // recipient was disconnected is confirmed on the sender but never shows
            // here. Debounced so WS flapping collapses into a single refresh.
            if (!wasOn || !this._reconnectCaughtUp) {
                this._reconnectCaughtUp = true;
                if (this._reconnectRefreshTimer) clearTimeout(this._reconnectRefreshTimer);
                this._reconnectRefreshTimer = setTimeout(() => {
                    this._reconnectRefreshTimer = null;
                    void this.syncActiveConversation({ force: true });
                    // Only the ACTIVE conversation was ever caught up above — a message
                    // sent to any OTHER contact while we were offline had nothing pulling
                    // it in: no WS push (we were offline when it fired) and no history
                    // refresh (only the open chat gets one). It sat on the server
                    // forever, invisible, until the user happened to click that exact
                    // contact — which also explains "contact doesn't appear when someone
                    // writes to you first" for a brand-new sender. Confirmed live
                    // 2026-07-04: a message server-confirmed as delivered to test1 never
                    // reached test3 across a reconnect because test3's client never had
                    // that DM open. Catch up every other known contact too, same as the
                    // active one; loadHistory() is peer-generic (ensureContact + merge
                    // into S.chats[peer]) so this is safe for any contact, not just the
                    // open one.
                    // Throttle the full-sweep catch-ups: each walks every contact and
                    // every channel of every server with sequential history refreshes.
                    // On a flaky link that flaps repeatedly, running the whole sweep on
                    // every reconnect saturates the connection pool ("чат не грузит").
                    // At most once per window is enough to catch up missed history.
                    const catchUpNow = Date.now();
                    if (catchUpNow - (this._lastReconnectCatchUpAt || 0) >= 20000) {
                        this._lastReconnectCatchUpAt = catchUpNow;
                        void this.catchUpBackgroundContactsAfterReconnect();
                        // Same class of bug as the DM catch-up above, for server channels:
                        // deliver_server_message (src/main.rs) only pushes to currently
                        // connected viewers via WS — a channel message posted while this
                        // client was offline, or simply in a channel/server you weren't
                        // looking at, has nothing pulling it in afterwards. Only the
                        // actively open channel got a history refresh; every other channel
                        // in every other server the user belongs to stayed stale until
                        // manually clicked.
                        void this.catchUpBackgroundChannelsAfterReconnect();
                    }
                }, 500);
            }
        } else {
            this._reconnectCaughtUp = false;
        }
    }

    async catchUpBackgroundContactsAfterReconnect() {
        if (!this.S.session?.token || !this.nativeSupports('sendMessage')) return;
        // this.S.contacts may still be empty here: bootstrapSession's own loadContacts()
        // is an independent async call racing against this reconnect timer, and on a
        // fresh launch/reconnect right after login it hadn't necessarily resolved yet —
        // an empty list made this whole catch-up silently iterate zero peers. Refresh
        // it ourselves first so the contact list is authoritative regardless of timing.
        await this.loadContacts();
        const activePeer = String(this.S.current || '').trim();
        const peers = (this.S.contacts || []).filter(peer => peer && peer !== activePeer);
        for (const peer of peers) {
            try {
                const key = await this.resolveConversationCryptoKey({ peer, reason: 'reconnectCatchUp' });
                this.postNativeMessage({ type: NativeMessageTypes.REFRESH_HISTORY, key, peer });
            } catch (e) {
                this.trace(`catchUpBackgroundContactsAfterReconnect failed peer=${peer} error=${e?.message || e}`);
            }
        }
    }

    async catchUpBackgroundChannelsAfterReconnect() {
        if (!this.S.session?.token) return;
        // Same staleness-on-launch race as loadContacts() above: refresh the server
        // list ourselves rather than trusting whatever bootstrapSession's independent
        // loadServers() call has resolved by now.
        await this.loadServers({ silent: true });
        const activeServer = String(this.S.activeServer || '').trim();
        const activeChannel = String(this.S.activeChannel || '').trim();
        for (const server of this.S.servers || []) {
            const sid = String(server?.id || '').trim();
            if (!sid) continue;
            for (const channel of server.channels || []) {
                const cid = String(channel?.id || '').trim();
                if (!cid || this.isVoiceChannel(channel)) continue;
                if (sid === activeServer && cid === activeChannel) continue;
                try {
                    await this.loadServerMessages(sid, cid, { silent: true });
                } catch (e) {
                    this.trace(`catchUpBackgroundChannelsAfterReconnect failed server=${sid} channel=${cid} error=${e?.message || e}`);
                }
            }
        }
    }

    kickPendingOutboxNow(reason = 'manual') {
        const pending = this.loadPendingOutbox();
        if (!pending.length) return;
        const now = Date.now();
        let changed = false;
        for (const item of pending) {
            if (!item || typeof item !== 'object') continue;
            // Any in-flight request was tied to the old connection and is now dead;
            // clear it and the backoff so the item is sent right away. The server
            // deduplicates by client_id, so an accidental resend is harmless.
            if (item.inFlight || Number(item.nextRetryAt || 0) > now) {
                item.inFlight = false;
                item.nextRetryAt = 0;
                changed = true;
            }
        }
        if (changed) this.savePendingOutbox(pending);
        this.trace(`kickPendingOutboxNow reason=${reason} count=${pending.length}`);
        this.scheduleFlushPendingOutbox(50);
    }

    onSendSuccess(payload) {
        if (payload && typeof payload === 'object') {
            this.trace(`onSendSuccess clientId=${String(payload.clientId || '').trim()} messageId=${String(payload.messageId || '').trim()}`);
            this.finalizePendingMessage(payload.clientId, payload.messageId);
            this.dropPendingOutbox(payload.clientId);
        } else {
            this.trace(`onSendSuccess payload=${String(payload || '').trim()}`);
            this.markMessageStatus(payload, 'sent');
            this.dropPendingOutbox(payload);
        }
        this.addLogEntry({ type: 'SUCCESS', msg: 'Сообщение подтверждено сервером', ts: new Date().toLocaleTimeString() });
    }

    onSendError(payload) {
        const clientId = String(payload?.clientId || payload || '').trim();
        const statusCode = Number(payload?.statusCode || 0);
        const responseBody = String(payload?.responseBody || '').trim();
        const permanentError = statusCode >= 400 && statusCode < 500;
        this.trace(`onSendError clientId=${clientId} status=${statusCode || 'n/a'} body=${responseBody.slice(0, 120)}`);
        if (clientId) {
            if (permanentError) {
                this.markMessageStatus(clientId, 'error');
                this.dropPendingOutbox(clientId);
            } else {
                this.markMessageStatus(clientId, 'sending');
                this.updatePendingOutboxItem(clientId, {
                    inFlight: false,
                    nextRetryAt: Date.now() + 2000,
                });
                this.scheduleFlushPendingOutbox(2000);
            }
        } else if (!permanentError) {
            this.scheduleFlushPendingOutbox(2000);
        }
        const networkError = !statusCode || statusCode <= 0;
        this.addLogEntry({
            type: permanentError ? 'ERROR' : 'WARN',
            msg: permanentError
                ? 'Сообщение отклонено сервером без ретрая'
                : (networkError
                    ? 'Сбой сети при отправке, повтор автоматически'
                    : 'Сервер временно недоступен, повтор отправки'),
            ts: new Date().toLocaleTimeString()
        });
    }

    onReactionUpdated(payload) {
        if (!payload || typeof payload !== 'object') return;
        const messageId = String(payload.messageId || payload.message_id || '').trim();
        if (!messageId) return;

        const normalizedReactions = this.normalizeReactions(payload.reactions);
        const normalizedMyReaction = String(payload.myReaction || payload.my_reaction || '').trim();
        let updated = false;

        const applyToList = (list) => {
            if (!Array.isArray(list)) return;
            for (const msg of list) {
                if (!msg || typeof msg !== 'object') continue;
                const sameId = String(msg.id || '').trim() === messageId;
                const sameClientId = String(msg.clientId || '').trim() === messageId;
                if (!sameId && !sameClientId) continue;
                msg.reactions = normalizedReactions;
                msg.myReaction = normalizedMyReaction;
                updated = true;
            }
        };

        for (const msgs of Object.values(this.S.chats || {})) {
            applyToList(msgs);
        }
        for (const msgs of Object.values(this.S.serverChats || {})) {
            applyToList(msgs);
        }

        if (updated) {
            this.scheduleSaveStoredMessageCache();
            const currentServerKey = this.currentServerChatKey();
            const currentPeer = String(this.S.current || '').trim();
            const payloadServerKey = String(payload.serverId || payload.server_id || '').trim() && String(payload.channelId || payload.channel_id || '').trim()
                ? `${String(payload.serverId || payload.server_id).trim()}:${String(payload.channelId || payload.channel_id).trim()}`
                : '';
            const shouldRender = payloadServerKey
                ? payloadServerKey === currentServerKey
                : currentPeer && (
                    currentPeer === String(payload.sender || '').trim() ||
                    currentPeer === String(payload.receiver || '').trim()
                );
            if (shouldRender) {
                this.scheduleRenderMessages();
            }
            return;
        }

        const serverId = String(payload.serverId || payload.server_id || '').trim();
        const channelId = String(payload.channelId || payload.channel_id || '').trim();
        const peer = String(payload.sender || payload.receiver || '').trim();
        if (serverId && channelId) {
            this.scheduleConversationRefresh({
                serverId,
                channelId,
                reason: 'reaction-miss',
                delayMs: 150,
            });
        } else if (peer) {
            this.scheduleConversationRefresh({
                peer,
                reason: 'reaction-miss',
                delayMs: 150,
            });
        }
    }

    addLogEntry({ type, msg, ts }) {
        // Mirror to console so the native console-hook persists the full in-app
        // journal to zali-debug.log on disk (readable without the UI).
        try { console.log(`[ZALI][JOURNAL] ${type}: ${msg}`); } catch (e) {}
        const body = document.getElementById('logBody');
        if (body) {
            const div = document.createElement('div');
            div.className = `log-entry log-${type}`;
            div.innerHTML = `<span class="ts">[${ts}]</span>${this.esc(type)}: ${this.esc(msg)}`;
            body.appendChild(div);
            body.scrollTop = body.scrollHeight;
            if (body.childElementCount > 300) body.removeChild(body.firstElementChild);
        }
    }

    voiceTrace(stage, details = {}, level = 'INFO') {
        const ts = new Date().toLocaleTimeString();
        const compact = Object.entries(details)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => {
                if (Array.isArray(value)) return `${key}=[${value.join(',')}]`;
                if (typeof value === 'object') {
                    try { return `${key}=${JSON.stringify(value)}`; } catch (e) { return `${key}=[object]`; }
                }
                return `${key}=${String(value)}`;
            })
            .join(' ');
        const message = compact ? `${stage} ${compact}` : stage;
        this.voice.traceLines = Array.isArray(this.voice.traceLines) ? this.voice.traceLines : [];
        this.voice.traceLines.push({ ts, level, stage, message });
        if (this.voice.traceLines.length > 14) {
            this.voice.traceLines.splice(0, this.voice.traceLines.length - 14);
        }
        this.addLogEntry({ type: level, msg: `[VOICE] ${message}`, ts });
        try {
            const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.debug;
            fn?.('[VOICE]', stage, details);
        } catch (e) {}
    }

    // --- UI Event Binding ---

    bindEvents() {
        // 1. Click on contacts
        const contactsEl = document.getElementById('contacts');
        if (contactsEl) {
            contactsEl.addEventListener('click', (e) => {
                const serverBtn = e.target.closest('.server-item[data-server-id]');
                if (serverBtn) {
                    const serverId = serverBtn.getAttribute('data-server-id');
                    if (serverId) this.setActiveServer(serverId);
                    e.stopPropagation();
                    return;
                }
                const createBtn = e.target.closest('.server-create');
                if (createBtn) {
                    this.openServerModal('create');
                    e.stopPropagation();
                    return;
                }
                const joinBtn = e.target.closest('.server-join');
                if (joinBtn) {
                    const raw = prompt('Введите ссылку на сервер:');
                    const link = this.extractInviteCode(raw);
                    if (link) this.joinServerByLink(link);
                    e.stopPropagation();
                    return;
                }
                const publicBtn = e.target.closest('.server-public');
                if (publicBtn) {
                    this.openPublicServersModal();
                    e.stopPropagation();
                    return;
                }
                const removeBtn = e.target.closest('.contact-remove');
                if (removeBtn) {
                    const username = removeBtn.getAttribute('data-remove-contact');
                    if (username) this.removeContact(username);
                    e.stopPropagation();
                    return;
                }
                const muteBtn = e.target.closest('.contact-mute-toggle');
                if (muteBtn) {
                    const username = muteBtn.getAttribute('data-toggle-mute-peer');
                    if (username) this.toggleMutePeer(username);
                    e.stopPropagation();
                    return;
                }
                const row = e.target.closest('.contact');
                if (row && row.dataset.name) this.switchChat(row.dataset.name);
            });
        }

        const serverChannelList = document.getElementById('serverChannelList');
        if (serverChannelList) {
            serverChannelList.addEventListener('click', (e) => {
                const channelMuteBtn = e.target.closest('.channel-mute-toggle');
                if (channelMuteBtn) {
                    const raw = channelMuteBtn.getAttribute('data-toggle-mute-channel') || '';
                    const [sid, cid] = raw.split(':');
                    if (sid && cid) this.toggleMuteChannel(sid, cid);
                    e.stopPropagation();
                    return;
                }
                const channelBtn = e.target.closest('.server-channel[data-channel-id]');
                if (!channelBtn) return;
                const channelId = channelBtn.getAttribute('data-channel-id');
                if (channelId) this.setActiveChannel(channelId);
            });
        }

        const voicePanel = document.getElementById('voicePanel');
        if (voicePanel) {
            voicePanel.addEventListener('click', async (e) => {
                const callBtn = e.target.closest('#voiceCallBtn');
                if (callBtn) {
                    await this.startDirectCall(this.S.current);
                    return;
                }
                const joinBtn = e.target.closest('#voiceJoinBtn');
                if (joinBtn) {
                    await this.joinVoiceChannel();
                    return;
                }
                const leaveBtn = e.target.closest('#voiceLeaveBtn');
                if (leaveBtn) {
                    await this.leaveVoiceRoom({ announce: true });
                    return;
                }
                const muteBtn = e.target.closest('#voiceMuteBtn');
                if (muteBtn) {
                    this.toggleVoiceMute();
                    return;
                }
                const acceptBtn = e.target.closest('#voiceAcceptBtn');
                if (acceptBtn) {
                    await this.acceptIncomingCall();
                    return;
                }
                const rejectBtn = e.target.closest('#voiceRejectBtn');
                if (rejectBtn) {
                    await this.rejectIncomingCall();
                    return;
                }
                const cancelBtn = e.target.closest('#voiceCancelBtn');
                if (cancelBtn) {
                    const invite = this.voice.outgoingInvite;
                    if (invite?.roomId && invite?.target) {
                        this.sendVoiceEvent({
                            type: 'voice_call_cancel',
                            roomId: invite.roomId,
                            target: invite.target,
                        });
                    }
                    this.recordVoiceCallHistory({ outcome: 'cancelled', endedAt: Date.now() });
                    this.resetVoiceState({ preserveInvite: false });
                }
            });
        }

        const chatCallBtn = document.getElementById('chatCallBtn');
        if (chatCallBtn) {
            chatCallBtn.addEventListener('click', async () => {
                if (!this.S.current) return;
                await this.startDirectCall(this.S.current);
            });
        }

        const msgsEl = document.getElementById('msgs');
        if (msgsEl) {
            msgsEl.addEventListener('scroll', () => this.onMessagesScroll(), { passive: true });
            msgsEl.addEventListener('click', (e) => {
                const fileLink = e.target.closest('a.file-chip, a.file-message');
                if (fileLink) {
                    e.preventDefault();
                    e.stopPropagation();
                    const href = fileLink.getAttribute('href') || '';
                    const filename = fileLink.getAttribute('download') || fileLink.textContent || 'attachment';
                    this.downloadAttachmentFromHref(href, filename);
                    return;
                }
                const reactionBtn = e.target.closest('[data-message-reaction]');
                if (reactionBtn) {
                    const messageId = reactionBtn.getAttribute('data-message-id');
                    const emoji = reactionBtn.getAttribute('data-message-reaction');
                    if (messageId && emoji) {
                        this.addReaction(messageId, emoji);
                    }
                    e.stopPropagation();
                    return;
                }
                this.hideReactionMenu();
            });
            msgsEl.addEventListener('contextmenu', (e) => {
                const msgEl = e.target.closest('.msg[data-message-id]');
                if (!msgEl) return;
                const messageId = msgEl.getAttribute('data-message-id');
                if (!messageId) return;
                e.preventDefault();
                this.showReactionMenu(msgEl, messageId, e.clientX, e.clientY);
                e.stopPropagation();
            });
        }

        document.addEventListener('click', (e) => {
            const menu = document.getElementById('reactionMenu');
            if (!menu || !menu.classList.contains('visible')) return;
            if (menu.contains(e.target)) return;
            if (e.target.closest('.msg[data-message-id]')) return;
            this.hideReactionMenu();
        });
        window.addEventListener('blur', () => this.hideReactionMenu());

        const contactAddBtn = document.getElementById('contactAddBtn');
        if (contactAddBtn) {
            contactAddBtn.addEventListener('click', () => {
                if (!this.S.session?.token) return;
                if (!this.S.contactAddMode) {
                    this.enterContactAddMode();
                    return;
                }
                this.addContactFromInput();
            });
        }

        const contactSuggestions = document.getElementById('contactSuggestions');
        if (contactSuggestions) {
            contactSuggestions.addEventListener('pointerdown', (e) => {
                const item = e.target.closest('.contact-suggest-item');
                if (!item) return;
                e.preventDefault();
                const username = item.getAttribute('data-username');
                if (username) {
                    this.addContactFromInput(username);
                }
            });
        }

        // 2. Click send button & keyboard listener
        const sendBtn = document.getElementById('sendBtn');
        if (sendBtn) sendBtn.addEventListener('click', () => this.sendInputMessage());

        const attachBtn = document.getElementById('attachBtn');
        const attachmentInput = document.getElementById('attachmentInput');
        if (attachBtn && attachmentInput) {
            attachBtn.addEventListener('click', () => attachmentInput.click());
            attachmentInput.addEventListener('change', (e) => {
                this.handleFiles(e.target.files || []);
                e.target.value = '';
            });
        }

        const msgInput = document.getElementById('msgInput');
        if (msgInput) {
            msgInput.addEventListener('input', () => {
                this.resizeComposer();
                this.updateSendButtonState();
            });
            msgInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { 
                    e.preventDefault(); 
                    this.sendInputMessage(); 
                }
            });
            msgInput.addEventListener('paste', (e) => {
                const files = Array.from(e.clipboardData?.files || []).filter(Boolean);
                if (files.length > 0) {
                    e.preventDefault();
                    this.handleFiles(files);
                }
            });
        }

        const inputBar = document.getElementById('inputBar');
        if (inputBar) {
            inputBar.addEventListener('dragover', (e) => {
                e.preventDefault();
                inputBar.classList.add('drop-active');
            });
            inputBar.addEventListener('dragleave', () => {
                inputBar.classList.remove('drop-active');
            });
            inputBar.addEventListener('drop', (e) => {
                e.preventDefault();
                inputBar.classList.remove('drop-active');
                const files = Array.from(e.dataTransfer?.files || []).filter(Boolean);
                if (files.length > 0) this.handleFiles(files);
            });
        }

        const draftAttachments = document.getElementById('draftAttachments');
        if (draftAttachments) {
            draftAttachments.addEventListener('click', (e) => {
                const btn = e.target.closest('.draft-att-remove');
                if (!btn) return;
                const id = btn.getAttribute('data-att-id');
                this.S.draftAttachments = this.S.draftAttachments.filter(att => att.id !== id);
                this.renderDraftAttachments();
                this.updateSendButtonState();
            });
        }

        // 3. Search filter input (doubles as the contact-add input while contactAddMode is on)
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                if (this.S.contactAddMode) {
                    const query = searchInput.value || '';
                    this.updateContactAddButtonState();
                    this.setContactStatus('');
                    void this.loadUsers(query).then(() => this.renderContactSuggestions(true));
                    return;
                }
                this.S.searchQ = e.target.value;
                this.renderContacts();
            });
            searchInput.addEventListener('focus', () => {
                if (!this.S.contactAddMode) return;
                const query = searchInput.value || '';
                this.setContactStatus('');
                void this.loadUsers(query).then(() => this.renderContactSuggestions(true));
            });
            searchInput.addEventListener('blur', () => {
                if (!this.S.contactAddMode) return;
                setTimeout(() => {
                    if (!this.S.contactAddMode) return;
                    if (!String(searchInput.value || '').trim()) {
                        this.exitContactAddMode();
                    } else {
                        this.hideContactSuggestions();
                    }
                }, 120);
            });
            searchInput.addEventListener('keydown', (e) => {
                if (!this.S.contactAddMode) return;
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this.exitContactAddMode();
                    searchInput.blur();
                    return;
                }
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.addContactFromInput();
                }
            });
        }

        const modeDmBtn = document.getElementById('modeDmBtn');
        const modeServersBtn = document.getElementById('modeServersBtn');
        if (modeDmBtn) modeDmBtn.addEventListener('click', () => this.setNavMode('dm'));
        if (modeServersBtn) modeServersBtn.addEventListener('click', () => this.setNavMode('servers'));
        const hubSegmentNav = document.getElementById('hubSegmentNav');
        if (hubSegmentNav) {
            hubSegmentNav.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-hub-segment]');
                if (!btn) return;
                this.handleHubSegment(btn.getAttribute('data-hub-segment'));
            });
        }

        const authForm = document.getElementById('authForm');
        const authLoginBtn = document.getElementById('authLoginBtn');
        if (authForm) {
            authForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.submitAuth(this.S.auth.mode);
            });
        }
        if (authLoginBtn) {
            authLoginBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.submitAuth(this.S.auth.mode);
            });
        }

        const authRegisterBtn = document.getElementById('authRegisterBtn');
        if (authRegisterBtn) authRegisterBtn.addEventListener('click', () => {
            this.setAuthMode(this.S.auth.mode === 'register' ? 'login' : 'register');
        });
        const inputVaultCloudSyncEnabled = document.getElementById('inputVaultCloudSyncEnabled');
        if (inputVaultCloudSyncEnabled) {
            inputVaultCloudSyncEnabled.addEventListener('change', () => {
                this.setVaultCloudSyncEnabled(!!inputVaultCloudSyncEnabled.checked);
            });
        }

        const authNetworkSaveBtn = document.getElementById('authNetworkSaveBtn');
        const authApiBaseUrl = document.getElementById('authApiBaseUrl');
        if (authApiBaseUrl) {
            authApiBaseUrl.addEventListener('input', () => {
                authApiBaseUrl.dataset.dirty = '1';
                const authNote = document.getElementById('authNetworkNote');
                const value = String(authApiBaseUrl.value || '').trim();
                if (authNote) {
                    authNote.textContent = value ? `Будет использован: ${value}` : 'Автоматически подставляется из настроек';
                }
            });
            authApiBaseUrl.addEventListener('blur', () => {
                this.syncAuthNetworkInput();
            });
        }
        if (authNetworkSaveBtn) {
            authNetworkSaveBtn.addEventListener('click', () => {
                const apiBaseUrl = String(authApiBaseUrl?.value || '').trim();
                if (!apiBaseUrl) {
                    this.addLogEntry({
                        type: 'ERROR',
                        msg: 'Укажите адрес API сервера',
                        ts: new Date().toLocaleTimeString(),
                    });
                    return;
                }
                const current = this.loadNetworkConfig();
                this.setNetworkConfig({
                    apiBaseUrl,
                    wsBaseUrl: this.deriveWsBaseUrl(apiBaseUrl),
                    iceServers: current.iceServers,
                });
                if (authApiBaseUrl) {
                    authApiBaseUrl.dataset.dirty = '0';
                }
                this.addLogEntry({
                    type: 'SUCCESS',
                    msg: `Адрес сервера обновлён: ${apiBaseUrl}`,
                    ts: new Date().toLocaleTimeString(),
                });
                this.updateAuthView();
            });
        }

        const authGuestBtn = document.getElementById('authGuestBtn');
        if (authGuestBtn) authGuestBtn.addEventListener('click', () => this.continueAsGuest());

        const authUsername = document.getElementById('authUsername');
        const authPassword = document.getElementById('authPassword');
        if (authUsername) {
            authUsername.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.submitAuth(this.S.auth.mode);
                }
            });
        }
        if (authPassword) {
            authPassword.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.submitAuth(this.S.auth.mode);
                }
            });
        }
        if (authApiBaseUrl) {
            authApiBaseUrl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    authNetworkSaveBtn?.click();
                }
            });
        }

        requestAnimationFrame(() => {
            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;
        });
        setTimeout(() => {
            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;
        }, 120);

        const settingsBtn = document.getElementById('settingsBtn');
        const serverSettingsBtn = document.getElementById('serverSettingsBtn');
        const serverOverlay = document.getElementById('serverOverlay');
        const serverModalClose = document.getElementById('serverModalClose');
        const serverModalCancel = document.getElementById('serverModalCancel');
        const serverSaveBtn = document.getElementById('serverSaveBtn');
        const serverDeleteBtn = document.getElementById('serverDeleteBtn');
        const serverMemberAddBtn = document.getElementById('serverMemberAddBtn');
        const serverJoinLinkGenerateBtn = document.getElementById('serverJoinLinkGenerateBtn');
        const serverJoinLinkCopyBtn = document.getElementById('serverJoinLinkCopyBtn');
        const serverAvatarUploadBtn = document.getElementById('serverAvatarUploadBtn');
        const serverAvatarRemoveBtn = document.getElementById('serverAvatarRemoveBtn');
        const serverBannerUploadBtn = document.getElementById('serverBannerUploadBtn');
        const serverBannerRemoveBtn = document.getElementById('serverBannerRemoveBtn');
        const serverRoleCreateBtn = document.getElementById('serverRoleCreateBtn');
        const serverRoleNameInput = document.getElementById('serverRoleNameInput');
        const settingsLogoutBtn = document.getElementById('settingsLogoutBtn');
        const clearLogsBtn = document.getElementById('clearLogs');
        const closeSettings = document.getElementById('closeSettings');
        const resetEncryptionKeysBtn = document.getElementById('resetEncryptionKeysBtn');
        const networkConfigSaveBtn = document.getElementById('networkConfigSaveBtn');
        const networkConfigResetBtn = document.getElementById('networkConfigResetBtn');
        const networkTurnApplyBtn = document.getElementById('networkTurnApplyBtn');
        const networkTurnFillBtn = document.getElementById('networkTurnFillBtn');
        const inputApiBaseUrl = document.getElementById('inputApiBaseUrl');
        const inputWsBaseUrl = document.getElementById('inputWsBaseUrl');
        const inputIceServers = document.getElementById('inputIceServers');
        const deviceTrustRefreshBtn = document.getElementById('deviceTrustRefreshBtn');
        const deviceVaultExportBtn = document.getElementById('deviceVaultExportBtn');
        const deviceVaultImportBtn = document.getElementById('deviceVaultImportBtn');
        const deviceTrustList = document.getElementById('deviceTrustList');
        const avatarUploadBtn = document.getElementById('avatarUploadBtn');
        const avatarResetBtn = document.getElementById('avatarResetBtn');
        const meAva = document.getElementById('meAva');
        const inputUiV2Enabled = document.getElementById('inputUiV2Enabled');
        const inputExperimentalDesign = document.getElementById('inputExperimentalDesign');
        const hubSegmentSettings = document.getElementById('hubSegmentSettings');
        const recentAccounts = document.getElementById('recentAccounts');

        const openAvatarPicker = () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.position = 'fixed';
            input.style.left = '-9999px';
            input.style.top = '0';
            input.style.width = '1px';
            input.style.height = '1px';
            input.style.opacity = '0';
            input.setAttribute('aria-hidden', 'true');
            document.body.appendChild(input);

            const cleanup = () => {
                input.removeEventListener('change', onChange);
                input.remove();
            };

            const onChange = async () => {
                const file = input.files && input.files[0];
                if (!file) {
                    cleanup();
                    return;
                }
                try {
                    const cropped = await this.openAvatarCropper(file);
                    if (!cropped) {
                        cleanup();
                        return;
                    }
                    await this.setProfileAvatar(cropped, this.myName());
                    this.addLogEntry({ type: 'SUCCESS', msg: `Аватар обновлён: ${this.myName()}`, ts: new Date().toLocaleTimeString() });
                } catch (err) {
                    this.addLogEntry({ type: 'ERROR', msg: err?.message || 'Не удалось обновить аватар', ts: new Date().toLocaleTimeString() });
                } finally {
                    cleanup();
                }
            };

            input.addEventListener('change', onChange, { once: true });
            input.click();
        };

        const showChatView = () => {
            this.openChatView();
        };

        const showSettingsView = () => {
            this.openSettingsView();
        };

        if (settingsBtn) settingsBtn.addEventListener('click', () => {
            this.applyNetworkConfigToInputs();
            this.renderUiV2Settings();
            showSettingsView();
        });
        if (inputUiV2Enabled) {
            inputUiV2Enabled.addEventListener('change', () => {
                this.saveUiV2Enabled(!!inputUiV2Enabled.checked);
            });
        }
        if (inputExperimentalDesign) {
            inputExperimentalDesign.addEventListener('change', () => {
                this.saveExperimentalDesign(!!inputExperimentalDesign.checked);
            });
        }
        if (hubSegmentSettings) {
            hubSegmentSettings.addEventListener('change', () => {
                const selected = Array.from(hubSegmentSettings.querySelectorAll('input[type="checkbox"]:checked'))
                    .map(input => String(input.value || '').trim())
                    .filter(Boolean);
                if (!selected.length) {
                    const first = hubSegmentSettings.querySelector('input[type="checkbox"]');
                    if (first) {
                        first.checked = true;
                        selected.push(String(first.value || 'dm'));
                    }
                }
                this.saveUiV2Segments(selected.slice(0, 3));
            });
        }
        if (deviceTrustRefreshBtn) {
            deviceTrustRefreshBtn.addEventListener('click', () => this.refreshDeviceTrust());
        }
        if (deviceVaultExportBtn) {
            deviceVaultExportBtn.addEventListener('click', () => this.exportCurrentVaultPackage());
        }
        if (deviceVaultImportBtn) {
            deviceVaultImportBtn.addEventListener('click', () => this.importVaultPackageFromInputs());
        }
        if (deviceTrustList) {
            deviceTrustList.addEventListener('click', (e) => {
                const approveBtn = e.target.closest('[data-device-approve]');
                if (approveBtn) {
                    this.approveDeviceAndExport(approveBtn.getAttribute('data-device-approve'));
                    return;
                }
                const revokeBtn = e.target.closest('[data-device-revoke]');
                if (revokeBtn) {
                    this.revokeTrustedDevice(revokeBtn.getAttribute('data-device-revoke'));
                }
            });
        }
        if (serverSettingsBtn) {
            serverSettingsBtn.addEventListener('click', () => {
                if (this.canManageServer()) {
                    this.openServerModal('edit', this.S.activeServer);
                }
            });
        }
        if (serverOverlay) {
            serverOverlay.addEventListener('click', (e) => {
                if (e.target === serverOverlay) {
                    this.closeServerOverlay();
                }
            });
        }
        const serverModalNav = document.getElementById('serverModalNav');
        if (serverModalNav) {
            serverModalNav.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-server-modal-section]');
                if (!btn || btn.hidden) return;
                const section = btn.getAttribute('data-server-modal-section');
                this.setServerModalSection(section);
            });
        }
        const serverModal = document.getElementById('serverModal');
        if (serverModal) {
            serverModal.addEventListener('click', (e) => {
                const toggle = e.target.closest('[data-color-picker-toggle]');
                if (!toggle) return;
                const key = String(toggle.getAttribute('data-color-picker-toggle') || '').trim();
                if (!key) return;
                this.toggleServerModalColorPicker(key);
            });
        }
        const serverDiscoverQuery = document.getElementById('serverDiscoverQuery');
        if (serverDiscoverQuery) {
            serverDiscoverQuery.addEventListener('input', () => this.renderPublicServersModal());
        }
        const serverDiscoverRefreshBtn = document.getElementById('serverDiscoverRefreshBtn');
        if (serverDiscoverRefreshBtn) {
            serverDiscoverRefreshBtn.addEventListener('click', () => this.loadPublicServers({ silent: true }));
        }
        if (serverModalClose) serverModalClose.addEventListener('click', () => this.closeServerOverlay());
        if (serverModalCancel) serverModalCancel.addEventListener('click', () => this.closeServerOverlay());
        if (serverSaveBtn) serverSaveBtn.addEventListener('click', () => this.submitServerModal());
        if (serverDeleteBtn) {
            serverDeleteBtn.addEventListener('click', async () => {
                const serverId = this.S.serverModal.serverId || this.S.activeServer;
                const server = (this.S.servers || []).find(item => item.id === serverId);
                if (!server || this.normalizeMemberRole(server.myRole || server.my_role || '') !== 'owner') return;
                const confirmDelete = confirm(`Удалить сервер "${server.name}"?`);
                if (!confirmDelete) return;
                try {
                    const res = await this.apiFetch(this.apiRoutes.servers.byId(serverId), { method: 'DELETE' });
                    if (!res.ok && res.status !== 204) {
                        throw new Error(await res.text() || 'Не удалось удалить сервер');
                    }
                    this.closeServerOverlay();
                    await this.loadServers({ silent: true });
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось удалить сервер' });
                    this.renderServerModal();
                }
            });
        }
        if (serverMemberAddBtn) {
            serverMemberAddBtn.addEventListener('click', async () => {
                const serverId = this.S.serverModal.serverId;
                const input = document.getElementById('serverMemberInput');
                const roleSelect = document.getElementById('serverMemberRole');
                const username = (input?.value || '').trim();
                const role = roleSelect?.value || 'member';
                if (!serverId || !username) return;
                try {
                    const res = await this.apiFetch(this.apiRoutes.servers.members(serverId), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, role }),
                    });
                    if (!res.ok) {
                        throw new Error(await res.text() || 'Не удалось добавить участника');
                    }
                    if (input) input.value = '';
                    const data = await res.json();
                    this.setServerModalState({
                        members: Array.isArray(data?.members) ? data.members : this.S.serverModal.members,
                        error: '',
                    });
                    this.renderServerModal();
                    await this.loadServers({ silent: true });
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось добавить участника' });
                    this.renderServerModal();
                }
            });
        }
        const serverChannelsList = document.getElementById('serverChannelsList');
        if (serverChannelsList) {
            serverChannelsList.addEventListener('click', async (e) => {
                const saveBtn = e.target.closest('[data-channel-save]');
                if (saveBtn) {
                    const channelId = saveBtn.getAttribute('data-channel-save');
                    try {
                        await this.saveServerChannel(channelId);
                    } catch (err) {
                        this.setServerModalState({ error: err?.message || 'Не удалось сохранить канал' });
                        this.renderServerModal();
                    }
                    return;
                }
                const deleteBtn = e.target.closest('[data-channel-delete]');
                if (deleteBtn) {
                    const channelId = deleteBtn.getAttribute('data-channel-delete');
                    if (!channelId) return;
                    try {
                        await this.deleteServerChannel(channelId);
                    } catch (err) {
                        this.setServerModalState({ error: err?.message || 'Не удалось удалить канал' });
                        this.renderServerModal();
                    }
                }
            });
        }
        if (serverJoinLinkGenerateBtn) {
            serverJoinLinkGenerateBtn.addEventListener('click', async () => {
                try {
                    const link = await this.generateServerJoinLink();
                    if (link) {
                        this.addLogEntry({ type: 'SUCCESS', msg: `Ссылка сервера обновлена`, ts: new Date().toLocaleTimeString() });
                    }
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось обновить ссылку' });
                    this.renderServerModal();
                }
            });
        }
        if (serverJoinLinkCopyBtn) {
            serverJoinLinkCopyBtn.addEventListener('click', async () => {
                const text = this.S.serverModal.joinLink || '';
                if (!text) return;
                try {
                    await navigator.clipboard.writeText(text);
                    this.addLogEntry({ type: 'SUCCESS', msg: 'Ссылка сервера скопирована', ts: new Date().toLocaleTimeString() });
                } catch (e) {
                    this.addLogEntry({ type: 'WARN', msg: 'Не удалось скопировать ссылку сервера', ts: new Date().toLocaleTimeString() });
                }
            });
        }
        const serverDiscoverList = document.getElementById('serverDiscoverList');
        if (serverDiscoverList) {
            serverDiscoverList.addEventListener('click', async (e) => {
                const card = e.target.closest('[data-public-server-id]');
                if (card && card.classList.contains('server-discover-item')) {
                    const serverId = card.getAttribute('data-public-server-id');
                    if (!serverId) return;
                    const server = (this.S.publicServers || []).find(item => String(item.id || '') === serverId);
                    if (!server) return;
                    const role = this.normalizeMemberRole(server.myRole || server.my_role || '');
                    if (role === 'owner' || role === 'admin' || role === 'member') {
                        this.closeServerOverlay();
                        this.setActiveServer(serverId);
                    } else {
                        await this.enterPublicServer(server.joinLink || server.join_link || server.id);
                    }
                    return;
                }
                const openBtn = e.target.closest('[data-public-server-open]');
                if (openBtn) {
                    const serverId = openBtn.getAttribute('data-public-server-open');
                    if (!serverId) return;
                    const server = (this.S.publicServers || []).find(item => String(item.id || '') === serverId);
                    if (!server) return;
                    if (this.normalizeMemberRole(server.myRole || server.my_role || '') === 'owner'
                        || this.normalizeMemberRole(server.myRole || server.my_role || '') === 'admin'
                        || this.normalizeMemberRole(server.myRole || server.my_role || '') === 'member') {
                        this.closeServerOverlay();
                        this.setActiveServer(serverId);
                        return;
                    }
                    await this.enterPublicServer(server.joinLink || server.join_link || server.id);
                    return;
                }
                const joinBtn = e.target.closest('[data-public-server-join]');
                if (joinBtn) {
                    await this.enterPublicServer(joinBtn.getAttribute('data-public-server-join'));
                }
            });
        }
        if (serverRoleCreateBtn) {
            serverRoleCreateBtn.addEventListener('click', async () => {
                const roleCreateOpen = !this.S.serverModal.roleCreateOpen;
                this.setServerModalState({ roleCreateOpen });
                this.renderServerModal();
            });
        }
        const serverChannelCreateBtn = document.getElementById('serverChannelCreateBtn');
        if (serverChannelCreateBtn) {
            serverChannelCreateBtn.addEventListener('click', async () => {
                if (this.S.serverModal.mode !== 'edit') return;
                const channelCreateOpen = !this.S.serverModal.channelCreateOpen;
                this.setServerModalState({ channelCreateOpen, error: '' });
                this.renderServerModal();
            });
        }
        const serverChannelCreateSubmitBtn = document.getElementById('serverChannelCreateSubmitBtn');
        if (serverChannelCreateSubmitBtn) {
            serverChannelCreateSubmitBtn.addEventListener('click', async () => {
                try {
                    await this.createServerChannel();
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось создать канал' });
                    this.renderServerModal();
                }
            });
        }
        const serverRoleCreateSubmitBtn = document.getElementById('serverRoleCreateSubmitBtn');
        if (serverRoleCreateSubmitBtn) {
            serverRoleCreateSubmitBtn.addEventListener('click', async () => {
                try {
                    const mode = this.S.serverModal.mode;
                    await this.createServerRole();
                    this.addLogEntry({
                        type: 'SUCCESS',
                        msg: mode === 'create' ? 'Черновик роли добавлен' : 'Роль создана',
                        ts: new Date().toLocaleTimeString(),
                    });
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось создать роль' });
                    this.renderServerModal();
                }
            });
        }
        const pickServerAsset = (kind) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.position = 'fixed';
            input.style.left = '-9999px';
            input.style.top = '0';
            document.body.appendChild(input);
            input.addEventListener('change', async () => {
                const file = input.files && input.files[0];
                if (!file) {
                    input.remove();
                    return;
                }
                try {
                    await this.uploadServerAsset(kind, file);
                    this.addLogEntry({ type: 'SUCCESS', msg: `${kind === 'avatar' ? 'Аватар' : 'Баннер'} сервера обновлён`, ts: new Date().toLocaleTimeString() });
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось обновить медиа сервера' });
                    this.renderServerModal();
                } finally {
                    input.remove();
                }
            }, { once: true });
            input.click();
        };
        if (serverAvatarUploadBtn) serverAvatarUploadBtn.addEventListener('click', () => pickServerAsset('avatar'));
        if (serverBannerUploadBtn) serverBannerUploadBtn.addEventListener('click', () => pickServerAsset('banner'));
        if (serverAvatarRemoveBtn) {
            serverAvatarRemoveBtn.addEventListener('click', async () => {
                try {
                    await this.removeServerAsset('avatar');
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось удалить аватар' });
                    this.renderServerModal();
                }
            });
        }
        if (serverBannerRemoveBtn) {
            serverBannerRemoveBtn.addEventListener('click', async () => {
                try {
                    await this.removeServerAsset('banner');
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось удалить баннер' });
                    this.renderServerModal();
                }
            });
        }
        if (settingsLogoutBtn) settingsLogoutBtn.addEventListener('click', () => this.logout());
        if (resetEncryptionKeysBtn) {
            const resetStatusEl = document.getElementById('resetEncryptionKeysStatus');
            const setResetStatus = (text, ok = true) => {
                if (!resetStatusEl) return;
                resetStatusEl.textContent = text;
                resetStatusEl.style.color = ok ? 'var(--lime)' : 'var(--red)';
                resetStatusEl.hidden = !text;
            };
            resetEncryptionKeysBtn.addEventListener('click', async () => {
                if (!confirm('Сбросить все ключи шифрования?\n\nВсе локальные ключи будут удалены, серверные энвелопы — тоже. После сброса ключи переустановятся автоматически при следующем сообщении.')) return;
                resetEncryptionKeysBtn.disabled = true;
                resetEncryptionKeysBtn.textContent = 'Сбрасываем…';
                setResetStatus('');
                try {
                    await this.resetEncryptionKeys();
                    setResetStatus('Ключи сброшены и перевыпущены');
                    this.addLogEntry({ type: 'SUCCESS', msg: 'Ключи шифрования сброшены и перевыпущены', ts: new Date().toLocaleTimeString() });
                } catch (e) {
                    setResetStatus(`Ошибка: ${e?.message || e}`, false);
                    this.addLogEntry({ type: 'ERROR', msg: `Сброс ключей не удался: ${e?.message || e}`, ts: new Date().toLocaleTimeString() });
                } finally {
                    resetEncryptionKeysBtn.disabled = false;
                    resetEncryptionKeysBtn.textContent = 'Сбросить ключи шифрования';
                    setTimeout(() => setResetStatus(''), 6000);
                }
            });
        }
        if (recentAccounts) {
            recentAccounts.addEventListener('click', (e) => {
                const target = e.target instanceof Element ? e.target : null;
                const switchBtn = target?.closest('[data-switch-account]');
                if (switchBtn && !switchBtn.disabled) {
                    this.switchRecentAccount(switchBtn.getAttribute('data-switch-account'));
                    return;
                }
                const removeBtn = target?.closest('[data-remove-recent-account]');
                if (removeBtn) {
                    this.forgetRecentAccount(removeBtn.getAttribute('data-remove-recent-account'));
                }
            });
        }
        if (avatarUploadBtn) {
            avatarUploadBtn.addEventListener('click', () => openAvatarPicker());
        }
        if (avatarResetBtn) {
            avatarResetBtn.addEventListener('click', async () => {
                try {
                    await this.resetProfileAvatar(this.myName());
                    this.addLogEntry({ type: 'SUCCESS', msg: 'Аватар профиля удалён', ts: new Date().toLocaleTimeString() });
                } catch (err) {
                    this.addLogEntry({ type: 'ERROR', msg: err?.message || 'Не удалось удалить аватар', ts: new Date().toLocaleTimeString() });
                }
            });
        }
        if (meAva) {
            meAva.title = 'Нажмите, чтобы сменить свой аватар';
            meAva.addEventListener('click', () => openAvatarPicker());
        }
        if (clearLogsBtn) {
            clearLogsBtn.addEventListener('click', () => {
                const logBody = document.getElementById('logBody');
                if (logBody) logBody.innerHTML = '';
            });
        }
        if (closeSettings) closeSettings.addEventListener('click', () => showChatView());
        const mobileMenuBtn = document.getElementById('mobileMenuBtn');
        if (mobileMenuBtn) {
            mobileMenuBtn.addEventListener('click', () => this.toggleMobileSidebar());
        }
        const mobileBackdrop = document.getElementById('mobileBackdrop');
        if (mobileBackdrop) {
            mobileBackdrop.addEventListener('click', () => this.closeMobileSidebar());
        }
        const mobileChatsBtn = document.getElementById('mobileChatsBtn');
        if (mobileChatsBtn) {
            mobileChatsBtn.addEventListener('click', () => {
                this.setNavMode('dm');
                showChatView();
                this.openMobileSidebar();
            });
        }
        const mobileServersBtn = document.getElementById('mobileServersBtn');
        if (mobileServersBtn) {
            mobileServersBtn.addEventListener('click', () => {
                this.setNavMode('servers');
                showChatView();
                this.openMobileSidebar();
            });
        }
        const mobileHubBtn = document.getElementById('mobileHubBtn');
        if (mobileHubBtn) {
            mobileHubBtn.addEventListener('click', () => this.openHubView());
        }
        const mobileSettingsBtn = document.getElementById('mobileSettingsBtn');
        if (mobileSettingsBtn) {
            mobileSettingsBtn.addEventListener('click', () => {
                this.applyNetworkConfigToInputs();
                showSettingsView();
            });
        }
        const hubGrid = document.getElementById('hubGrid');
        if (hubGrid) {
            hubGrid.addEventListener('click', (e) => {
                const actionCard = e.target.closest('[data-hub-action]');
                if (actionCard) {
                    const action = actionCard.getAttribute('data-hub-action');
                    if (action === 'components') {
                        document.getElementById('hubComponents')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                    return;
                }
                const card = e.target.closest('[data-hub-segment]');
                if (!card) return;
                this.handleHubSegment(card.getAttribute('data-hub-segment'));
            });
        }
        if (networkConfigSaveBtn) {
            networkConfigSaveBtn.addEventListener('click', () => {
                let iceServers = [];
                try {
                    iceServers = this.parseIceServersText(inputIceServers?.value || '');
                } catch (error) {
                    this.addLogEntry({
                        type: 'ERROR',
                        msg: `Не удалось сохранить network config: ${error?.message || error}`,
                        ts: new Date().toLocaleTimeString(),
                    });
                    return;
                }
                const turnUrl = String(document.getElementById('inputTurnUrl')?.value || '').trim();
                if (turnUrl) {
                    try {
                        iceServers = this.appendTurnPresetToIceServers(iceServers);
                    } catch (error) {
                        this.addLogEntry({
                            type: 'ERROR',
                            msg: `Не удалось добавить TURN: ${error?.message || error}`,
                            ts: new Date().toLocaleTimeString(),
                        });
                        return;
                    }
                }
                this.setNetworkConfig({
                    apiBaseUrl: inputApiBaseUrl?.value || '',
                    wsBaseUrl: inputWsBaseUrl?.value || '',
                    iceServers,
                });
            });
        }
        if (networkConfigResetBtn) {
            networkConfigResetBtn.addEventListener('click', () => this.resetNetworkConfig());
        }
        if (networkTurnApplyBtn) {
            networkTurnApplyBtn.addEventListener('click', () => {
                try {
                    const nextIceServers = this.appendTurnPresetToIceServers(
                        this.parseIceServersText(inputIceServers?.value || '')
                    );
                    this.setNetworkConfig({
                        apiBaseUrl: inputApiBaseUrl?.value || '',
                        wsBaseUrl: inputWsBaseUrl?.value || '',
                        iceServers: nextIceServers,
                    });
                } catch (error) {
                    this.addLogEntry({
                        type: 'ERROR',
                        msg: `Не удалось добавить TURN: ${error?.message || error}`,
                        ts: new Date().toLocaleTimeString(),
                    });
                }
            });
        }
        if (networkTurnFillBtn) {
            networkTurnFillBtn.addEventListener('click', () => {
                const turnUrlInput = document.getElementById('inputTurnUrl');
                const turnUsernameInput = document.getElementById('inputTurnUsername');
                const turnCredentialInput = document.getElementById('inputTurnCredential');
                const turnRelayOnlyInput = document.getElementById('inputTurnRelayOnly');
                if (turnUrlInput) turnUrlInput.value = 'turns:turn.example.com:5349';
                if (turnUsernameInput) turnUsernameInput.value = 'user';
                if (turnCredentialInput) turnCredentialInput.value = 'pass';
                if (turnRelayOnlyInput) turnRelayOnlyInput.checked = true;
            });
        }

        this.bindColorWheel({
            wheelId: 'serverColorWheel',
            hiddenId: 'serverColorInput',
            hexId: 'serverColorHexInput',
            initialValue: '#cbff00',
        });
        this.bindColorWheel({
            wheelId: 'serverRoleColorWheel',
            hiddenId: 'serverRoleColorInput',
            hexId: 'serverRoleColorHexInput',
            initialValue: '#cbff00',
        });

        // 6. Dynamic styler selector events
        document.querySelectorAll('.btn-theme').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const themeName = e.currentTarget.getAttribute('data-theme');
                this.bus.send('zali_styler:set_theme', themeName);
            });
        });

        const serverMembersList = document.getElementById('serverMembersList');
        if (serverMembersList) {
            serverMembersList.addEventListener('change', async (e) => {
                const roleSelect = e.target.closest('select[data-member-role]');
                if (!roleSelect) return;
                const serverId = this.S.serverModal.serverId;
                const username = roleSelect.getAttribute('data-member-role');
                if (!serverId || !username) return;
                try {
                    const res = await this.apiFetch(this.apiRoutes.servers.member(serverId, username), {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, role: roleSelect.value }),
                    });
                    if (!res.ok) {
                        throw new Error(await res.text() || 'Не удалось изменить роль');
                    }
                    const data = await res.json();
                    this.setServerModalState({
                        members: Array.isArray(data?.members) ? data.members : this.S.serverModal.members,
                        error: '',
                    });
                    this.renderServerModal();
                    await this.loadServers({ silent: true });
                } catch (err) {
                    this.setServerModalState({ error: err?.message || 'Не удалось изменить роль' });
                    this.renderServerModal();
                }
            });

            serverMembersList.addEventListener('click', async (e) => {
                const removeBtn = e.target.closest('[data-member-remove]');
                if (!removeBtn) return;
                const serverId = this.S.serverModal.serverId;
                const username = removeBtn.getAttribute('data-member-remove');
                if (!serverId || !username) return;
                try {
                    const res = await this.apiFetch(this.apiRoutes.servers.member(serverId, username), {
                        method: 'DELETE',
                    });
                    if (!res.ok && res.status !== 204) {
                        throw new Error(await res.text() || 'Не удалось удалить участника');
                    }
                    if (res.status === 204) {
                        this.setServerModalState({
                            members: (this.S.serverModal.members || []).filter(member => String(member.username || '') !== username),
                            error: '',
                        });
                        this.renderServerModal();
                        await this.loadServers({ silent: true });
                        return;
                    }
                    const data = await res.json();
                    this.setServerModalState({
                        members: Array.isArray(data?.members) ? data.members : this.S.serverModal.members,
                        error: '',
                    });
                    this.renderServerModal();
                    await this.loadServers({ silent: true });
                } catch (err) {
                    this.setServerModalState({ error: err?.message || 'Не удалось удалить участника' });
                    this.renderServerModal();
                }
            });
        }

        const serverRolesList = document.getElementById('serverRolesList');
        if (serverRolesList) {
            serverRolesList.addEventListener('input', () => {
                if (this.S.serverModal.mode !== 'create') return;
                this.syncDraftServerRolesFromDom();
            });
            serverRolesList.addEventListener('click', async (e) => {
                const draftToggleBtn = e.target.closest('[data-draft-role-toggle]');
                if (draftToggleBtn) {
                    if (this.S.serverModal.mode !== 'create') return;
                    const draftId = String(draftToggleBtn.getAttribute('data-draft-role-toggle') || '').trim();
                    if (!draftId) return;
                    const nextRoles = this.syncDraftServerRolesFromDom().map(role => {
                        if (String(role.draftId || '') !== draftId) return role;
                        return {
                            ...role,
                            collapsed: !role.collapsed,
                        };
                    });
                    this.setServerModalState({ draftRoles: nextRoles, error: '' });
                    this.renderServerModal();
                    return;
                }
                const draftHead = e.target.closest('.server-role-head--draft');
                if (draftHead) {
                    if (this.S.serverModal.mode !== 'create') return;
                    const card = draftHead.closest('[data-draft-role-card]');
                    const draftId = String(card?.getAttribute('data-draft-role-card') || '').trim();
                    if (!draftId) return;
                    const nextRoles = this.syncDraftServerRolesFromDom().map(role => {
                        if (String(role.draftId || '') !== draftId) return role;
                        return {
                            ...role,
                            collapsed: !role.collapsed,
                        };
                    });
                    this.setServerModalState({ draftRoles: nextRoles, error: '' });
                    this.renderServerModal();
                    return;
                }
                const draftDeleteBtn = e.target.closest('[data-draft-role-delete]');
                if (draftDeleteBtn) {
                    if (this.S.serverModal.mode !== 'create') return;
                    const draftId = String(draftDeleteBtn.getAttribute('data-draft-role-delete') || '').trim();
                    if (!draftId) return;
                    const nextRoles = this.syncDraftServerRolesFromDom().filter(role => String(role.draftId || '') !== draftId);
                    this.setServerModalState({ draftRoles: nextRoles, error: '' });
                    this.renderServerModal();
                    return;
                }
                const saveBtn = e.target.closest('[data-role-save]');
                if (saveBtn) {
                    const roleId = saveBtn.getAttribute('data-role-save');
                    try {
                        await this.saveServerRole(roleId);
                        this.addLogEntry({ type: 'SUCCESS', msg: `Роль обновлена: ${roleId}`, ts: new Date().toLocaleTimeString() });
                    } catch (err) {
                        this.setServerModalState({ error: err?.message || 'Не удалось сохранить роль' });
                        this.renderServerModal();
                    }
                    return;
                }
                const deleteBtn = e.target.closest('[data-role-delete]');
                if (deleteBtn) {
                    const roleId = deleteBtn.getAttribute('data-role-delete');
                    if (!roleId) return;
                    const role = (this.S.serverModal.roles || []).find(item => String(item.roleId || '') === roleId);
                    const confirmDelete = confirm(`Удалить роль "${role?.name || roleId}"?`);
                    if (!confirmDelete) return;
                    try {
                        await this.deleteServerRole(roleId);
                        this.addLogEntry({ type: 'SUCCESS', msg: `Роль удалена: ${role?.name || roleId}`, ts: new Date().toLocaleTimeString() });
                    } catch (err) {
                        this.setServerModalState({ error: err?.message || 'Не удалось удалить роль' });
                        this.renderServerModal();
                    }
                }
            });
        }

        const sliderSuggestHeight = document.getElementById('sliderSuggestHeight');
        if (sliderSuggestHeight) {
            sliderSuggestHeight.addEventListener('input', (e) => {
                const height = `${e.target.value}px`;
                const out = document.getElementById('suggestHeightVal');
                if (out) out.textContent = height;
                this.bus.send('zali_styler:set_variable', '--contact-suggest-max-h', height);
            });
        }

        const sliderSuggestContrast = document.getElementById('sliderSuggestContrast');
        if (sliderSuggestContrast) {
            sliderSuggestContrast.addEventListener('input', (e) => {
                const percent = Number(e.target.value) || 0;
                const bgAlpha = Math.min(0.98, Math.max(0.72, 0.58 + (percent / 100) * 0.32));
                const borderAlpha = Math.min(0.95, Math.max(0.18, 0.08 + (percent / 100) * 0.28));
                const shadowAlpha = Math.min(0.65, Math.max(0.24, 0.12 + (percent / 100) * 0.5));
                const bg = `rgba(8,10,14,${bgAlpha.toFixed(3)})`;
                const border = `rgba(255,255,255,${borderAlpha.toFixed(3)})`;
                const shadow = `0 22px 48px rgba(0,0,0,${shadowAlpha.toFixed(3)})`;
                const out = document.getElementById('suggestContrastVal');
                if (out) out.textContent = `${percent}%`;
                this.bus.send('zali_styler:set_variable', '--contact-suggest-bg', bg);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-border', border);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-shadow', shadow);
            });
        }

        const sliderSuggestDensity = document.getElementById('sliderSuggestDensity');
        if (sliderSuggestDensity) {
            sliderSuggestDensity.addEventListener('input', (e) => {
                const density = Number(e.target.value) || 0;
                const padY = Math.max(8, 16 - Math.round(density / 3));
                const padX = Math.max(10, 16 - Math.round(density / 4));
                const gap = Math.max(4, 12 - Math.round(density / 3));
                const font = Math.min(16, 13 + Math.round(density / 8));
                const hint = Math.max(0.34, Math.min(0.72, 0.42 + density / 60));
                const out = document.getElementById('suggestDensityVal');
                if (out) out.textContent = String(density);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-item-pad-y', `${padY}px`);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-item-pad-x', `${padX}px`);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-gap', `${gap}px`);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-font', `${font}px`);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-hint', `rgba(255,255,255,${hint.toFixed(3)})`);
            });
        }

        // 7. Cryptography setting custom key
        // Routes through zali_styler which proxies to Swift → Rust backend
        const inputCryptoKey = document.getElementById('inputCryptoKey');
        if (inputCryptoKey) {
            const storedKey = this.loadStoredCryptoKey();
            if (storedKey && !inputCryptoKey.value.trim()) {
                inputCryptoKey.value = storedKey;
            }
            inputCryptoKey.addEventListener('input', (e) => {
                const newKey = e.target.value.trim();
                this.saveStoredCryptoKey(newKey);
                this.bus.send('zali_styler:set_key', newKey);
            });
        }

        // 8. Title bar drag helper
        const titlebar = document.getElementById('titlebar');
        if (titlebar && this.nativeSupports('windowDrag')) {
            titlebar.addEventListener('mousedown', (e) => {
                if (!e.target.closest('.ws-pill') && !e.target.closest('.hdr-btn')) {
                    this.postNativeMessage({ type: NativeMessageTypes.START_DRAG });
                }
            });
        }

        // Report app loaded
        this.addLogEntry({ type: 'INFO', msg: 'ZaliMessenger v6.0 (Rust Backend) запущен — шифрование и сетевой стек работают в Rust', ts: new Date().toLocaleTimeString() });
        this.resizeComposer();
        this.syncMobileChrome();
        this.applyUiV2Chrome();
        this.applyExperimentalDesign();
        const mobileQuery = this.mobileLayoutQuery();
        if (mobileQuery) {
            const onMobileChange = () => {
                if (!this.isMobileLayout()) {
                    this.closeMobileSidebar();
                }
                this.syncMobileChrome();
            };
            if (typeof mobileQuery.addEventListener === 'function') {
                mobileQuery.addEventListener('change', onMobileChange);
            } else if (typeof mobileQuery.addListener === 'function') {
                mobileQuery.addListener(onMobileChange);
            }
        }
        window.addEventListener('resize', () => {
            if (!this.isMobileLayout()) {
                this.closeMobileSidebar();
            }
            this.syncMobileChrome();
        }, { passive: true });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isMobileLayout() && document.body?.classList.contains('mobile-sidebar-open')) {
                this.closeMobileSidebar();
            }
        });
    }
}
window.ZaliInterface = ZaliInterface;


// --- MODULE: bootstrap.js ---
// @ts-check
(function() {
    'use strict';

    function createNativeBridge() {
        const macBridge = window.webkit?.messageHandlers?.nativeApp || null;
        const wryBridge = window.ipc?.postMessage ? window.ipc : null;
        const webView2Bridge = window.chrome?.webview?.postMessage ? window.chrome.webview : null;
        // Android's WebView.addJavascriptInterface() only exposes plain methods on a
        // named window object (not a .postMessage(obj) pattern that accepts arbitrary
        // JS objects like WKWebView's message handlers) — the native side only ever
        // sees strings, so payloads are always JSON-stringified first, same as wry/webview2.
        const androidBridge = window.ZaliAndroidBridge?.postMessage ? window.ZaliAndroidBridge : null;

        const transport = macBridge
            ? {
                kind: 'webkit',
                postMessage(payload) {
                    macBridge.postMessage(payload);
                    return true;
                },
            }
            : wryBridge
                ? {
                    kind: 'ipc',
                    postMessage(payload) {
                        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
                        wryBridge.postMessage(data);
                        return true;
                    },
                }
                : webView2Bridge
                    ? {
                        kind: 'webview2',
                        postMessage(payload) {
                            const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
                            webView2Bridge.postMessage(data);
                            return true;
                        },
                    }
                    : androidBridge
                        ? {
                            kind: 'android',
                            postMessage(payload) {
                                const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
                                androidBridge.postMessage(data);
                                return true;
                            },
                        }
                        : null;

        const defaultCaps = macBridge
            ? {
                sendMessage: true,
                sessionSync: true,
                networkConfig: true,
                setKey: true,
                saveStyle: true,
                saveMessageCache: true,
                downloadAttachment: true,
                serverHistory: true,
                avatarFetch: true,
                tenor: true,
                voice: true,
                windowDrag: true,
            }
            : transport
                ? {
                    sendMessage: true,
                sessionSync: true,
                networkConfig: true,
                setKey: true,
                saveStyle: true,
                saveMessageCache: true,
                downloadAttachment: false,
                serverHistory: false,
                tenor: false,
                voice: false,
                    windowDrag: false,
                }
                : {};

        const injectedCaps = window.__ZALI_NATIVE_CAPS__ && typeof window.__ZALI_NATIVE_CAPS__ === 'object'
            ? window.__ZALI_NATIVE_CAPS__
            : {};

        return {
            available: !!transport,
            transport: transport ? transport.kind : 'none',
            supports: { ...defaultCaps, ...injectedCaps },
            postMessage(payload) {
                if (!transport) return false;
                return transport.postMessage(payload);
            },
        };
    }

    window.__ZALI_NATIVE = createNativeBridge();

    // Register the app-shell service worker only in standalone browser/PWA mode — native
    // shells (macOS/Windows) load this HTML via loadHTMLString/a data string with no real
    // origin, where SW registration would be meaningless at best. See web/service-worker.js.
    if (!window.__ZALI_NATIVE?.available && 'serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./service-worker.js').catch(() => {});
        });
    }

    // Create the minimal JS-side loader (only interface + styler)
    const loader = new ZaliLoader();

    // Register only frontend modules.
    // Crypto, Net, Bus logic live in the Rust backend (Core crate).
    loader.register(new ZaliStyler());
    loader.register(new ZaliInterface());

    // Initialize all registered modules
    loader.init();

    // Expose loader to window for native iOS/macOS WebView invocation
    window.loader = loader;
    
    // Legacy helper functions that native layer calls directly
    window.receiveMessage = function(...args) {
        if (args.length === 1 && args[0] && typeof args[0] === 'object') {
            loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.RECEIVE_MESSAGE || 'receive_message'}`, args[0]);
            return;
        }
        const [id, sender, receiver, text, attachments, serverId, channelId] = args;
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.RECEIVE_MESSAGE || 'receive_message'}`, { id, sender, receiver, text, attachments, serverId, channelId });
    };
    window.receiveReactionUpdate = function(payload) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.REACTION_UPDATED || 'reaction_updated'}`, payload);
    };
    window.receiveVoiceEvent = function(payload) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.VOICE_EVENT || 'voice_event'}`, payload);
    };
    window.setUsers = function(users) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_USERS || 'set_users'}`, users);
    };
    window.setContacts = function(contacts) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_CONTACTS || 'set_contacts'}`, contacts);
    };
    window.setSession = function(session) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_SESSION || 'set_session'}`, session);
    };
    window.loadHistory = function(messages) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.LOAD_HISTORY || 'load_history'}`, messages);
    };
    window.refreshAfterKey = function() {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.REFRESH_AFTER_KEY || 'refresh_after_key'}`);
    };
    window.loadServerHistory = function(serverId, channelId, messages) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.LOAD_SERVER_HISTORY || 'load_server_history'}`, { serverId, channelId, messages });
    };
    window.setLoading = function(on) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_LOADING || 'set_loading'}`, on);
    };
    window.setConnectionStatus = function(connected) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_CONNECTION_STATUS || 'set_connection_status'}`, connected);
    };
    window.avatarUpdated = function(username) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.AVATAR_UPDATED || 'avatar_updated'}`, { username, deleted: false });
    };
    window.avatarDeleted = function(username) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.AVATAR_UPDATED || 'avatar_updated'}`, { username, deleted: true });
    };
    window.addLog = function(type, msg) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.ADD_LOG_ENTRY || 'add_log_entry'}`, { type, msg, ts: new Date().toLocaleTimeString() });
    };

    const hasNativeBridge = !!window.__ZALI_NATIVE?.available;
    if (!hasNativeBridge) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_USERS || 'set_users'}`, ['Alice', 'Bob', 'Zalikus']);
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_LOADING || 'set_loading'}`, false);
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_CONNECTION_STATUS || 'set_connection_status'}`, false);
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.ADD_LOG_ENTRY || 'add_log_entry'}`, {
            type: 'WARN',
            msg: 'Запущен браузерный режим без native bridge: доступен просмотр интерфейса',
            ts: new Date().toLocaleTimeString()
        });
    }
})();

</script>
</body>
</html>

"""#
}
