"use client";

import styles from "./page.module.css";
import Image from "next/image";
import { useEffect } from "react";

// SVG Icons as components
const Icons = {
  bolt: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7,10 12,15 17,10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  ),
  github: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  ),
  keyboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" ry="2"/>
      <line x1="6" y1="8" x2="6" y2="8"/>
      <line x1="10" y1="8" x2="10" y2="8"/>
      <line x1="14" y1="8" x2="14" y2="8"/>
      <line x1="18" y1="8" x2="18" y2="8"/>
      <line x1="6" y1="12" x2="6" y2="12"/>
      <line x1="18" y1="12" x2="18" y2="12"/>
      <line x1="8" y1="16" x2="16" y2="16"/>
    </svg>
  ),
  clipboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
    </svg>
  ),
  clock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  ),
  palette: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"/>
      <circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"/>
      <circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"/>
      <circle cx="6.5" cy="12.5" r="0.5" fill="currentColor"/>
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z"/>
    </svg>
  ),
  pin: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="17" x2="12" y2="22"/>
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>
    </svg>
  ),
  focus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <circle cx="12" cy="12" r="6"/>
      <circle cx="12" cy="12" r="2"/>
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  ),
  window: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <line x1="3" y1="9" x2="21" y2="9"/>
    </svg>
  ),
  command: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>
    </svg>
  ),
  apple: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 22 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.09997 22C7.78997 22.05 6.79997 20.68 5.95997 19.47C4.24997 17 2.93997 12.45 4.69997 9.39C5.56997 7.87 7.12997 6.91 8.81997 6.88C10.1 6.86 11.32 7.75 12.11 7.75C12.89 7.75 14.37 6.68 15.92 6.84C16.57 6.87 18.39 7.1 19.56 8.82C19.47 8.88 17.39 10.1 17.41 12.63C17.44 15.65 20.06 16.66 20.09 16.67C20.06 16.74 19.67 18.11 18.71 19.5ZM13 3.5C13.73 2.67 14.94 2.04 15.94 2C16.07 3.17 15.6 4.35 14.9 5.19C14.21 6.04 13.07 6.7 11.95 6.61C11.8 5.46 12.36 4.26 13 3.5Z"/>
    </svg>
  ),
  windows: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801"/>
    </svg>
  ),
};

// URLs
const URLS = {
  github: "https://github.com/pcstyleorg/messenger-desktop",
  releases: "https://github.com/pcstyleorg/messenger-desktop/releases",
  themeCreator: "https://mstheme.pcstyle.dev",
};

export default function HomeClient({ version }: { version: string }) {
  useEffect(() => {
    // Intersection Observer for scroll animations
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add(styles.visible);
          }
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -50px 0px" }
    );

    document.querySelectorAll(`.${styles.animateIn}`).forEach((el) => {
      observer.observe(el);
    });

    // Staggered animation delay for feature cards
    document.querySelectorAll(`.${styles.featureCard}`).forEach((card, index) => {
      (card as HTMLElement).style.transitionDelay = `${index * 0.05}s`;
    });

    return () => observer.disconnect();
  }, []);

  return (
    <main>
      {/* Navigation */}
      <nav className={styles.nav}>
        <a href="#" className={styles.logo}>
          <div className={styles.logoIcon}>{Icons.bolt}</div>
          Messenger Unleashed
        </a>
        <ul className={styles.navLinks}>
          <li><a href="#features">Features</a></li>
          <li><a href="#themes">Themes</a></li>
          <li><a href={URLS.github} target="_blank" rel="noopener noreferrer">GitHub</a></li>
          <li><a href={URLS.themeCreator} target="_blank" rel="noopener noreferrer">Theme Creator</a></li>
        </ul>
        <a href="#download" className={styles.navCta}>
          {Icons.download}
          Download
        </a>
      </nav>

      {/* Hero Section */}
      <section className={styles.hero}>
        <div className={styles.heroGlow} />
        
        <div className={styles.heroContent}>
          <div className={styles.badge}>
            <span className={styles.badgeDot}></span>
            <span className="mono">{version} — MIT Licensed</span>
          </div>
          
          <h1 className={styles.heroTitle}>
            Messenger,<br/>
            <span>Unleashed.</span>
          </h1>
          
          <p className={`${styles.tagline} mono`}>chat on your terms</p>
          
          <p className={styles.heroDescription}>
            A supercharged desktop client for Messenger with privacy features, 
            deep customization, and power-user tools. Block read receipts. 
            Choose from 17+ themes. Schedule messages. All in a native app 
            that respects your privacy.
          </p>
          
          <div className={styles.ctaGroup}>
            <a href={URLS.releases} target="_blank" rel="noopener noreferrer" className={`${styles.btn} ${styles.btnPrimary}`}>
              {Icons.download}
              Download Free
            </a>
            <a href={URLS.github} target="_blank" rel="noopener noreferrer" className={`${styles.btn} ${styles.btnSecondary}`}>
              {Icons.github}
              View Source
            </a>
          </div>
        </div>

        <div className={styles.heroVisual}>
          <div className={styles.appPreview}>
            <Image 
              src="/app-screenshot.png"
              alt="Messenger Unleashed App"
              width={600}
              height={450}
              priority
            />
          </div>
          
          <div className={`${styles.floatBadge} ${styles.floatBadgeTop}`}>
            {Icons.lock}
            <span>Read receipts blocked</span>
          </div>
          <div className={`${styles.floatBadge} ${styles.floatBadgeBottom}`}>
            {Icons.palette}
            <span>17+ themes</span>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className={styles.features} id="features">
        <div className={`${styles.sectionHeader} ${styles.animateIn}`}>
          <h2 className={styles.sectionTitle}>Features that matter.</h2>
          <p className={styles.sectionDesc}>Built for people who want more from their messenger.</p>
        </div>

        <div className={styles.featureGrid}>
          {/* Privacy Cards */}
          <div className={`${styles.featureCard} ${styles.featureCardPrivacy} ${styles.animateIn}`}>
            <div className={`${styles.featureIcon} ${styles.featureIconCyan}`}>{Icons.lock}</div>
            <h3>Block Read Receipts</h3>
            <p>Others won&apos;t know when you&apos;ve read their messages. Take your time to respond.</p>
          </div>

          <div className={`${styles.featureCard} ${styles.featureCardPrivacy} ${styles.animateIn}`}>
            <div className={`${styles.featureIcon} ${styles.featureIconCyan}`}>{Icons.keyboard}</div>
            <h3>Hide Typing Indicator</h3>
            <p>Craft your message in peace without the pressure of &ldquo;typing...&rdquo; showing.</p>
          </div>

          <div className={`${styles.featureCard} ${styles.featureCardPrivacy} ${styles.animateIn}`}>
            <div className={`${styles.featureIcon} ${styles.featureIconCyan}`}>{Icons.clipboard}</div>
            <h3>Clipboard Sanitizer</h3>
            <p>Strip tracking metadata from pasted content. Keep your pastes clean.</p>
          </div>

          <div className={`${styles.featureCard} ${styles.featureCardPower} ${styles.animateIn}`}>
            <div className={`${styles.featureIcon} ${styles.featureIconOrange}`}>{Icons.clock}</div>
            <h3>Scheduled Messages</h3>
            <p>Delay sending with configurable timer. 5s, 10s, 30s, or 60s options.</p>
          </div>

          {/* Theme Card - Large */}
          <div className={`${styles.featureCard} ${styles.featureCardCustomize} ${styles.featureLarge} ${styles.animateIn}`} id="themes">
            <div className={styles.featureLargeContent}>
              <div className={`${styles.featureIcon} ${styles.featureIconMagenta}`}>{Icons.palette}</div>
              <h3>17+ Built-in Themes</h3>
              <p>OLED Dark, Nord, Dracula, Solarized, and vibrant colors like Crimson, Ultraviolet, Hot Magenta, and Cyber Teal.</p>
              <a href={URLS.themeCreator} target="_blank" rel="noopener noreferrer" className={`${styles.btn} ${styles.btnSecondary}`} style={{marginTop: '1rem'}}>
                Create Your Own Theme
              </a>
            </div>
            <div className={styles.featureDemo}>
              <div className={styles.themePreview}>
                <div className={styles.themeSwatch} style={{background: 'linear-gradient(135deg, #0a0a0a, #1a1a1a)'}} title="OLED Dark" />
                <div className={styles.themeSwatch} style={{background: 'linear-gradient(135deg, #2e3440, #4c566a)'}} title="Nord" />
                <div className={styles.themeSwatch} style={{background: 'linear-gradient(135deg, #282a36, #6272a4)'}} title="Dracula" />
                <div className={styles.themeSwatch} style={{background: 'linear-gradient(135deg, #002b36, #268bd2)'}} title="Solarized" />
                <div className={styles.themeSwatch} style={{background: 'linear-gradient(135deg, #dc143c, #8b0000)'}} title="Crimson" />
                <div className={styles.themeSwatch} style={{background: 'linear-gradient(135deg, #5b21b6, #7c3aed)'}} title="Ultraviolet" />
                <div className={styles.themeSwatch} style={{background: 'linear-gradient(135deg, #ff1493, #c71585)'}} title="Hot Magenta" />
                <div className={styles.themeSwatch} style={{background: 'linear-gradient(135deg, #00bcd4, #006064)'}} title="Cyber Teal" />
              </div>
            </div>
          </div>

          {/* Keyboard Card - Large */}
          <div className={`${styles.featureCard} ${styles.featureCardPower} ${styles.featureLarge} ${styles.animateIn}`}>
            <div className={styles.featureLargeContent}>
              <div className={`${styles.featureIcon} ${styles.featureIconOrange}`}>{Icons.command}</div>
              <h3>Keyboard Navigation</h3>
              <p>Navigate conversations with Cmd+↑/↓, search with Cmd+K. Built for speed.</p>
            </div>
            <div className={styles.terminalDemo}>
              <div className={styles.terminalHeader}>
                <span>⌘</span> Keyboard shortcuts
              </div>
              <div className={styles.terminalBody}>
                <div className={styles.terminalLine}><span className={styles.terminalPrompt}>⌘K</span> <span className={styles.terminalCommand}>Search conversations</span></div>
                <div className={styles.terminalLine}><span className={styles.terminalPrompt}>⌘↑</span> <span className={styles.terminalCommand}>Previous chat</span></div>
                <div className={styles.terminalLine}><span className={styles.terminalPrompt}>⌘↓</span> <span className={styles.terminalCommand}>Next chat</span></div>
                <div className={styles.terminalLine}><span className={styles.terminalPrompt}>⌘.</span> <span className={styles.terminalCommand}>Toggle focus mode</span></div>
              </div>
            </div>
          </div>

          <div className={`${styles.featureCard} ${styles.featureCardDesktop} ${styles.animateIn}`}>
            <div className={`${styles.featureIcon} ${styles.featureIconPurple}`}>{Icons.pin}</div>
            <h3>Always on Top</h3>
            <p>Pin the window above all others. Never lose your conversation.</p>
          </div>

          <div className={`${styles.featureCard} ${styles.featureCardDesktop} ${styles.animateIn}`}>
            <div className={`${styles.featureIcon} ${styles.featureIconPurple}`}>{Icons.focus}</div>
            <h3>Focus Mode</h3>
            <p>Hide the chat list for distraction-free conversations.</p>
          </div>

          <div className={`${styles.featureCard} ${styles.featureCardPower} ${styles.animateIn}`}>
            <div className={`${styles.featureIcon} ${styles.featureIconOrange}`}>{Icons.bell}</div>
            <h3>Keyword Alerts</h3>
            <p>Get notified when specific keywords appear in messages.</p>
          </div>

          <div className={`${styles.featureCard} ${styles.featureCardCustomize} ${styles.animateIn}`}>
            <div className={`${styles.featureIcon} ${styles.featureIconMagenta}`}>{Icons.window}</div>
            <h3>Window Opacity</h3>
            <p>Adjust transparency to 25%, 50%, 75%, or 100%. See through your chat.</p>
          </div>
        </div>
      </section>

      {/* Showcase Section */}
      <section className={styles.showcase}>
        <div className={`${styles.sectionHeader} ${styles.animateIn}`}>
          <h2 className={styles.sectionTitle}>Desktop-first experience.</h2>
          <p className={styles.sectionDesc}>All the features you&apos;d expect from a native app.</p>
        </div>

        <div className={styles.showcaseGrid}>
          <div className={`${styles.showcaseCard} ${styles.animateIn}`}>
            <span className={styles.showcaseNumber}>01</span>
            <h3>System Integration</h3>
            <p>Feels right at home on your desktop.</p>
            <ul className={styles.showcaseList}>
              <li>Menu bar mode (hide from dock)</li>
              <li>Launch at login</li>
              <li>Do Not Disturb mode</li>
              <li>Native notifications</li>
            </ul>
          </div>

          <div className={`${styles.showcaseCard} ${styles.animateIn}`}>
            <span className={styles.showcaseNumber}>02</span>
            <h3>Customization</h3>
            <p>Make it truly yours.</p>
            <ul className={styles.showcaseList}>
              <li>Custom CSS injection</li>
              <li>Visual theme creator</li>
              <li>Glassmorphism mode</li>
              <li>Compact UI option</li>
            </ul>
          </div>

          <div className={`${styles.showcaseCard} ${styles.animateIn}`}>
            <span className={styles.showcaseNumber}>03</span>
            <h3>Productivity</h3>
            <p>Tools that help you get things done.</p>
            <ul className={styles.showcaseList}>
              <li>Quick reply templates</li>
              <li>Picture-in-Picture</li>
              <li>Session export/import</li>
              <li>Spell check built-in</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Download Section */}
      <section className={styles.download} id="download">
        <div className={styles.downloadGlow} />
        
        <div className={styles.downloadContent}>
          <h2 className={`${styles.downloadTitle} ${styles.animateIn}`}>Ready to unleash?</h2>
          <p className={`${styles.downloadDesc} ${styles.animateIn}`}>Free. Open source. Forever.</p>

          <div className={`${styles.downloadButtons} ${styles.animateIn}`}>
            <a href={URLS.releases} target="_blank" rel="noopener noreferrer" className={styles.downloadBtn}>
              {Icons.apple}
              <div className={styles.downloadBtnText}>
                <span className={styles.downloadBtnLabel}>Download for</span>
                <span className={styles.downloadBtnPlatform}>macOS</span>
              </div>
            </a>

            <a href={URLS.releases} target="_blank" rel="noopener noreferrer" className={styles.downloadBtn}>
              {Icons.windows}
              <div className={styles.downloadBtnText}>
                <span className={styles.downloadBtnLabel}>Download for</span>
                <span className={styles.downloadBtnPlatform}>Windows</span>
              </div>
            </a>
          </div>

          <div className={`${styles.techBadge} ${styles.animateIn}`}>
            {Icons.bolt}
            Built with Electron · Auto-updates included
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className={styles.footer}>
        <div className={styles.footerLeft}>
          <div className={styles.footerLogo}>
            <div className={styles.footerLogoIcon}>{Icons.bolt}</div>
            Messenger Unleashed
          </div>
          <ul className={styles.footerLinks}>
            <li><a href={URLS.github} target="_blank" rel="noopener noreferrer">GitHub</a></li>
            <li><a href={URLS.themeCreator} target="_blank" rel="noopener noreferrer">Theme Creator</a></li>
            <li><a href={URLS.releases} target="_blank" rel="noopener noreferrer">Releases</a></li>
          </ul>
        </div>
        <div className={styles.footerRight}>
          MIT License · Made for power users
        </div>
      </footer>
    </main>
  );
}
