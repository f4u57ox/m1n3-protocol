"use client";

/**
 * Lazy YouTube embed for the homepage demo video.
 *
 * Renders a static thumbnail with a play button on first paint — zero
 * YouTube iframe, zero Google scripts, zero tracking until the visitor
 * actually opts in. Click swaps in the iframe with `autoplay=1` so play
 * starts immediately and there's no second click.
 *
 * Why this matters:
 *   - The standard YouTube `<iframe>` pulls ~500 KB of JS plus the
 *     player chrome on every page load even if the user never scrolls
 *     to it; the thumbnail is a single ~30 KB JPEG from
 *     `i.ytimg.com/vi/<id>/maxresdefault.jpg`.
 *   - Defers the Google cookie until consent-by-click.
 *   - No CLS: the wrapper holds a fixed `aspect-video` (16:9) so the
 *     thumbnail and the iframe occupy identical box geometry.
 *
 * Design rhythm mirrors `IntroSection` and `HomeCTA`: same `max-w-6xl`,
 * same vertical padding scale, same eyebrow label + headline pattern,
 * same `rounded-2xl border-border` card treatment.
 */

import { useState } from "react";
import { Play } from "lucide-react";

interface DemoVideoProps {
  /** YouTube video id (the `v` query param). */
  videoId: string;
  /** Optional title used as the iframe's accessible name. */
  title?: string;
}

export function DemoVideo({ videoId, title = "m1n3 protocol demo" }: DemoVideoProps) {
  const [isPlaying, setIsPlaying] = useState(false);

  // `maxresdefault` is 1280×720; falls back at the CDN if missing.
  const thumbnail = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  const embedUrl = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1`;

  return (
    <section className="relative bg-background pb-8 sm:pb-12 md:pb-16">
      <div className="mx-auto max-w-6xl px-4">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-[10px] sm:text-[11px] uppercase tracking-[0.35em] sm:tracking-[0.4em] text-muted-foreground">
            Walkthrough
          </p>
          <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
            See it run end-to-end
          </h2>
          <p className="mt-4 sm:mt-5 text-balance text-sm text-muted-foreground sm:text-base md:text-lg">
            ASIC → stratum → Sui submit_share → claim_reward, in one take.
          </p>
        </div>

        <div className="mt-10 sm:mt-14 md:mt-16">
          <div className="relative mx-auto aspect-video w-full max-w-4xl overflow-hidden rounded-2xl border border-border bg-card/40 shadow-lg backdrop-blur">
            {isPlaying ? (
              <iframe
                src={embedUrl}
                title={title}
                className="absolute inset-0 h-full w-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                loading="lazy"
              />
            ) : (
              <button
                type="button"
                onClick={() => setIsPlaying(true)}
                aria-label={`Play ${title}`}
                className="group absolute inset-0 flex items-center justify-center"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={thumbnail}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
                  loading="lazy"
                  decoding="async"
                />
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-black/0 to-black/0" />
                <div className="pointer-events-none relative flex h-16 w-16 items-center justify-center rounded-full bg-foreground/95 text-background shadow-2xl transition-transform duration-300 group-hover:scale-110 sm:h-20 sm:w-20">
                  <Play className="h-7 w-7 translate-x-0.5 fill-current sm:h-9 sm:w-9" strokeWidth={0} />
                </div>
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
