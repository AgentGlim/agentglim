// portable-ui.js (ES module): the "Your AI agent" popup, the small agent-status banner and the process-guard badge.
// What shows is decided by agentNotice() in agent-notice.mjs, the one rule: the popup only while the setup file is
// NOT filled out (setupFilled from the server); on a configured install, stale data, a lost connection or no SuperAgent
// heartbeat is a small non-blocking banner, never the popup. The popup keeps no stored "dismissed" flag on purpose:
// it is gone for good once setup is filled out, and while setup is missing it shows once per page load.
import { agentNotice, OFFLINE_MS } from '/agent-notice.mjs';
(() => {
  const style=document.createElement('style');style.textContent=`#agentHelp{color:var(--ink,#e9ebee);background:var(--panel,#121418);border:1px solid var(--border-strong,#424751);border-radius:14px;max-width:540px;padding:24px}#agentHelp::backdrop{background:var(--shadow-60,#0009)}#agentHelp h2{font-size:20px}#agentHelp p{line-height:1.6}#agentHelp a{color:var(--info,#5fb8ff)}#agentHelp button{font:inherit;cursor:pointer;border:1px solid var(--border-strong,#424751);border-radius:6px;background:var(--panel2,#171a1f);color:var(--ink,#e9ebee);padding:6px 12px}#agentNote{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0 12px;padding:6px 12px;border:1px solid var(--notice-border,#6b5426);border-radius:8px;background:var(--notice-bg,#2a2112);color:var(--warning-text,#f0c674);font-size:13px;line-height:1.5}#agentNote[hidden]{display:none}#agentNote button{margin-left:auto;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--notice-border,#6b5426);border-radius:6px;background:transparent;color:var(--warning-text,#f0c674);padding:2px 10px}#guardBadge{display:inline-flex;align-items:center;gap:6px;margin-left:10px;padding:2px 10px;border-radius:99px;border:1px solid var(--warn,#e0a84f);color:var(--warning-text,#f0c674);background:var(--notice-bg,#2a2112);font-size:12px;text-decoration:none;vertical-align:middle}#guardBadge[hidden]{display:none}:focus-visible{outline:2px solid var(--accent,#8f8bf0);outline-offset:3px}`;document.head.append(style);
  const dialog=document.createElement('dialog');dialog.id='agentHelp';dialog.setAttribute('aria-labelledby','agentHelpTitle');dialog.innerHTML='<h2 id="agentHelpTitle">Your AI agent</h2><p id="agentHelpText"></p><p><a href="/setup">Open Setup</a> · <a href="/skills">Skill Editor</a></p><button type="button">Continue to dashboard</button>';document.body.append(dialog);dialog.querySelector('button').onclick=()=>dialog.close();
  // configured installs: one line under the header; Hide keeps it hidden until the notice changes or clears
  const note=document.createElement('div');note.id='agentNote';note.setAttribute('role','status');note.hidden=true;note.innerHTML='<span id="agentNoteText"></span><button type="button" aria-label="Hide this notice">Hide</button>';
  const header=document.querySelector('header');if(header)header.after(note);else document.body.prepend(note);
  // AI agent activity and the process guard live on their own page (/process-guard, Pages menu). The dashboard
  // only shows a small badge, and only when a flagged process needs a Stop / Allow decision.
  const panel=document.createElement('a');panel.id='guardBadge';panel.href='/process-guard';panel.hidden=true;panel.setAttribute('role','status');
  const h1=document.querySelector('h1');if(h1)h1.append(panel);else document.body.prepend(panel);
  const messages={
    setup:'Open an AI agent (Claude Code, Codex...) in the agentglim/ folder and ask it to set up AgentGlim. When it’s done, ask it to be your SuperAgent.',
    stale:'AgentGlim data looks stale. Ask your AI agent to refresh AgentGlim (send status).',
    offline:'Lost the connection to AgentGlim; retrying. If it stays, ask your AI agent to refresh AgentGlim (send status).',
    watcher:'No SuperAgent heartbeat in the last 45 minutes. Open the agentglim folder, launch an AI agent and ask it to be your SuperAgent.',
  };
  let last=null,lastSnapshot=Date.now(),offlineSince=0,modalKind='',bannerKind='',hiddenKind='';
  note.querySelector('button').onclick=()=>{hiddenKind=bannerKind;note.hidden=true;};
  // the dashboard closes its stream while the tab is hidden, so hidden time never counts as "no snapshot"
  const quietMs=()=>document.hidden ? 0 : Date.now()-lastSnapshot;
  function update() {
    const n=agentNotice(last,{offlineMs:offlineSince ? Date.now()-offlineSince : 0,quietMs:quietMs()});
    if(n.modal){if(n.modal!==modalKind){document.getElementById('agentHelpText').textContent=messages[n.modal];if(!dialog.open)dialog.showModal();modalKind=n.modal;}}
    else{if(dialog.open)dialog.close();modalKind='';}
    bannerKind=n.banner || '';if(!bannerKind)hiddenKind='';
    if(bannerKind)document.getElementById('agentNoteText').textContent=messages[bannerKind];
    note.hidden=!bannerKind || bannerKind===hiddenKind;note.dataset.kind=bannerKind;
  }
  function draw(snapshot) {
    lastSnapshot=Date.now();offlineSince=0;const state=snapshot?.portable;if(!state)return update();last=state;update();
    const n=(state.guard?.flagged || []).length;panel.hidden=!n;
    panel.textContent=n ? `${n} process${n===1 ? '' : 'es'} need${n===1 ? 's' : ''} a decision` : '';panel.title='Process guard: Stop or Allow on its page';
  }
  const offline=()=>{if(!offlineSince){offlineSince=Date.now();setTimeout(update,OFFLINE_MS+500);}update();};
  window.addEventListener('agentglim:snapshot',e=>draw(e.detail));
  window.addEventListener('agentglim:offline',offline);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){lastSnapshot=Date.now();update();}});
  // Initial state is small and independent of dashboard rendering failures.
  fetch('/api/portable',{cache:'no-store'}).then(r=>r.json()).then(state=>{if(!last){last=state;update();}}).catch(offline);
  setInterval(update,30000);
})();
