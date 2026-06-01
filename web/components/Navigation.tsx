"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { Sun, Moon, Menu, X } from "lucide-react";
import Image from "next/image";

const internalLinks = [
  { href: "/pool", label: "Pool" },
];

const externalLinks = [
  { href: "https://github.com/f4u57ox/m1n3-protocol", label: "GitHub" },
  { href: "https://github.com/f4u57ox/m1n3-protocol/tree/main/docs", label: "Docs" },
];

// Crypto glyphs pool — mostly hex/hash symbols, rare bitcoin
const RAIN_GLYPHS = "0123456789abcdef".split("");
const RAIN_BITCOIN_GLYPH = "\u20BF";
const RAIN_BTC_CHANCE = 1 / 60;
const RAIN_MAX_DROPS = 24;
const RAIN_INITIAL_DROPS = 18;
const RAIN_SPAWN_INTERVAL = 800;

function MatrixRain() {
  const containerRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const dropCountRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function spawnDrop(initialDelay?: number) {
      if (!container) return;
      const isBtc = Math.random() < RAIN_BTC_CHANCE;
      const char = isBtc
        ? RAIN_BITCOIN_GLYPH
        : RAIN_GLYPHS[Math.floor(Math.random() * RAIN_GLYPHS.length)];
      const duration = 3 + Math.random() * 5;
      const delay = initialDelay ?? 0;
      const opacity = isBtc ? 0.18 : 0.04 + Math.random() * 0.06;
      const size = 10 + Math.random() * 4;

      const span = document.createElement("span");
      span.textContent = char;
      span.style.cssText = `
        position: absolute;
        left: ${Math.random() * 100}%;
        top: -1.5em;
        font-size: ${size}px;
        opacity: ${opacity};
        color: ${isBtc ? "#f7931a" : "currentColor"};
        animation: navrain ${duration}s linear ${delay}s infinite;
        font-family: var(--font-mono, monospace);
        user-select: none;
      `;

      // Recycle on each animation iteration
      span.addEventListener("animationiteration", () => {
        const newIsBtc = Math.random() < RAIN_BTC_CHANCE;
        const newChar = newIsBtc
          ? RAIN_BITCOIN_GLYPH
          : RAIN_GLYPHS[Math.floor(Math.random() * RAIN_GLYPHS.length)];
        span.textContent = newChar;
        span.style.left = `${Math.random() * 100}%`;
        span.style.opacity = String(newIsBtc ? 0.18 : 0.04 + Math.random() * 0.06);
        span.style.color = newIsBtc ? "#f7931a" : "currentColor";
      });

      container.appendChild(span);
      dropCountRef.current++;
    }

    // Seed initial drops staggered
    for (let i = 0; i < RAIN_INITIAL_DROPS; i++) {
      spawnDrop(Math.random() * 6);
    }

    // Gradually add more drops
    intervalRef.current = setInterval(() => {
      if (dropCountRef.current < RAIN_MAX_DROPS) {
        spawnDrop();
      }
    }, RAIN_SPAWN_INTERVAL);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (container) container.innerHTML = "";
      dropCountRef.current = 0;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
    />
  );
}

export function Navigation() {
  const { theme, setTheme } = useTheme();
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setMobileMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <nav className="relative border-b bg-card z-50">
      <MatrixRain />

      <div className="relative z-10 mx-auto flex h-14 max-w-7xl items-center px-4 gap-6" ref={mobileMenuRef}>
        <Link href="/" className="flex items-center">
          <Image
            src="/m1n3w.png"
            alt="m1n3"
            width={80}
            height={27}
            className="hidden dark:block"
            priority
          />
          <Image
            src="/m1n3b.png"
            alt="m1n3"
            width={80}
            height={27}
            className="block dark:hidden"
            priority
          />
        </Link>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-1">
          {internalLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors hover:text-foreground hover:bg-accent ${
                pathname === link.href
                  ? "text-foreground bg-accent"
                  : "text-muted-foreground"
              }`}
            >
              {link.label}
            </Link>
          ))}
          {externalLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-md text-sm font-medium transition-colors text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="rounded-md p-2 hover:bg-accent transition-colors"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </button>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileMenuOpen((o) => !o)}
            className="md:hidden rounded-md p-2 hover:bg-accent transition-colors"
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {/* Mobile menu panel */}
        {mobileMenuOpen && (
          <div className="absolute left-0 top-full w-full border-b bg-card shadow-md md:hidden z-50">
            <div className="flex flex-col p-2 gap-1">
              {internalLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`block px-4 py-2.5 rounded-md text-sm font-medium transition-colors hover:text-foreground hover:bg-accent ${
                    pathname === link.href
                      ? "text-foreground bg-accent"
                      : "text-muted-foreground"
                  }`}
                >
                  {link.label}
                </Link>
              ))}
              {externalLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMobileMenuOpen(false)}
                  className="block px-4 py-2.5 rounded-md text-sm font-medium transition-colors text-muted-foreground hover:text-foreground hover:bg-accent"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
