import Image from "next/image";

/**
 * "Powered by" badge row — Sui · DeepBook · Hashi.
 *
 * Theme-aware via Tailwind's dark/light class swap (matches the
 * Navigation logo pattern). We have two DeepBook variants in
 * `public/`; only Hashi ships a single asset that reads well on
 * both themes.
 */
export function PoweredBy() {
  return (
    <div className="flex flex-col items-center gap-3 py-6">
      <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-muted-foreground">
        Powered by
      </p>
      <ul className="flex flex-wrap items-center justify-center gap-x-7 gap-y-3 sm:gap-x-10">
        <li>
          <a
            href="https://sui.io"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Sui"
            className="opacity-75 transition-opacity hover:opacity-100"
          >
            <span className="font-mono text-sm font-semibold tracking-tight">
              Sui
            </span>
          </a>
        </li>
        <li>
          <a
            href="https://deepbook.tech"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="DeepBook"
            className="block opacity-80 transition-opacity hover:opacity-100"
          >
            <Image
              src="/deepbook-white.svg"
              alt="DeepBook"
              width={90}
              height={20}
              className="hidden h-5 w-auto dark:block"
              priority={false}
            />
            <Image
              src="/deepbook-black.svg"
              alt="DeepBook"
              width={90}
              height={20}
              className="block h-5 w-auto dark:hidden"
              priority={false}
            />
          </a>
        </li>
        <li>
          <a
            href="https://github.com/MystenLabs/hashi"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Hashi"
            className="block opacity-80 transition-opacity hover:opacity-100"
          >
            <Image
              src="/hashi.svg"
              alt="Hashi"
              width={70}
              height={20}
              className="h-5 w-auto"
              priority={false}
            />
          </a>
        </li>
      </ul>
    </div>
  );
}
