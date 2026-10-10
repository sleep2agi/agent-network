---
layout: home
title: Agent Network
hero:
  name: Agent Network
  # The tagline lives only in hero.text: the <title> suffix, description and og/twitter tags are derived from
  # hero.text / hero.tagline by transformPageData in .vitepress/config.ts, so swapping it is a one-line change.
  text: One person. A whole team of agents.
  tagline: Chat with your Claude, Codex and Grok nodes, hand out work and set schedules — like a group chat. Tasks get followed up, routines run on time, and your data stays on your own machines.
  actions:
    - theme: brand
      text: Download the desktop app
      link: /en/download
    - theme: alt
      text: Read the docs
      link: /en/guide/getting-started

features:
  - icon: 💬
    title: Command it like a chat
    details: Message, send images and files, or start a group chat — messages and tasks live in one place.
  - icon: 🖥️
    title: See your whole team at a glance
    details: Who's online, who's busy, who's stuck — nodes, tasks and runtime status on one desktop screen.
  - icon: 🔐
    title: Your team runs on your machines
    details: The Hub and your data run on hardware you control; sign-in credentials are kept in the operating-system keychain.
---

<section class="feature-shots" aria-labelledby="feature-shots-title">
  <div class="feature-shots-heading"><span class="eyebrow">INSIDE THE APP</span><h2 id="feature-shots-title">Not just chat: assign, follow up and schedule in one place</h2><p>You and your whole team of agents split the work, follow it up and run it on time from one board.</p></div>
  <figure class="feature-shot">
    <div class="feature-shot-frame"><img src="/features/tasks-board.webp" alt="Task board with backlog, in-progress and done columns; cards show owner and agent avatars plus due-today and overdue badges" width="2560" height="1600" loading="lazy" decoding="async" /></div>
    <figcaption><span class="feature-shot-kicker">Task board</span><h3>See who is on what at a glance</h3><p>Backlog, in progress, and done sit side by side, and every card shows its owner, the agent teammate doing the work, and when it is due.</p></figcaption>
  </figure>
  <figure class="feature-shot">
    <div class="feature-shot-frame"><img src="/features/task-detail.webp" alt="Task detail: participants include both a team member and an agent, followed by the description and comments" width="2560" height="1600" loading="lazy" decoding="async" /></div>
    <figcaption><span class="feature-shot-kicker">Task detail</span><h3>You and your agents work on the same task</h3><p>Each task has an owner, participants, and a description, and you and your agent teammates post progress in the same comment thread.</p></figcaption>
  </figure>
  <figure class="feature-shot">
    <div class="feature-shot-frame"><img src="/features/scheduled-tasks.webp" alt="Scheduled tasks: a daily briefing at 09:00, a weekly review on Fridays at 17:30 and other plans, with the plan details and run history on the right" width="2560" height="1600" loading="lazy" decoding="async" /></div>
    <figcaption><span class="feature-shot-kicker">Scheduled tasks</span><h3>Routine work runs on time</h3><p>Set a time for a daily briefing or a weekly review and it goes to an agent teammate automatically, with a record of every run.</p></figcaption>
  </figure>
</section>

<section class="desktop-download" aria-labelledby="desktop-download-title">
  <div class="desktop-download-copy">
    <span class="eyebrow">DESKTOP AND MOBILE</span>
    <h2 id="desktop-download-title">Download and start collaborating</h2>
    <p>Installers live on the download page and follow the current published release. Mac and Windows connect to the same Hubs, accounts, and conversations.</p>
    <div class="download-note">The Mac build is Apple silicon. Windows is 64-bit Windows 10/11. iOS is TestFlight only, and the public link is not open yet.</div>
  </div>
  <div class="download-grid">
    <a class="download-card download-card-primary" href="/en/download#macos"><span class="download-platform">Desktop</span><strong>macOS / Windows / Linux</strong><small>Open the latest installers</small></a>
    <a class="download-card" href="/en/download#android"><span class="download-platform">Phone</span><strong>Android / iOS</strong><small>Android package; iOS uses TestFlight</small></a>
  </div>
</section>

<section class="product-path">
  <div class="product-path-heading"><span class="eyebrow">TWO WAYS TO START</span><h2>Desktop simplicity, full CLI power</h2></div>
  <div class="product-path-grid">
    <article class="product-path-card"><span class="path-number">01</span><h3>Desktop app</h3><p>For everyday work: manage agents, conversations, files, schedules, and servers visually.</p><a href="/en/download">Get the latest release →</a></article>
    <article class="product-path-card"><span class="path-number">02</span><h3>anet CLI</h3><p>For developers and servers: control Hubs, nodes, runtimes, and automation precisely.</p><div class="cli-command"><code>curl -fsSL https://anet.sh/install.sh | sh</code></div><a href="/en/guide/getting-started">Read the install guide →</a></article>
  </div>
</section>

<section class="final-cta">
  <h2 class="final-cta-title">Turn your agents into a real team</h2>
  <p class="final-cta-sub">Start with the desktop app or build your own network with anet CLI.</p>
  <div class="final-cta-actions"><a class="cta-primary" href="/en/download">Download desktop</a><a class="cta-ghost" href="/en/guide/getting-started">Developer docs</a><a class="cta-ghost" href="https://github.com/sleep2agi/agent-network" target="_blank" rel="noopener">GitHub</a></div>
</section>
