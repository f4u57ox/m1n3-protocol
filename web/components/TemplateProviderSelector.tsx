"use client";

import { useMemo } from "react";
import { useTemplates } from "@/hooks/useTemplates";
import { truncateAddress } from "@/lib/utils";

interface TemplateProviderSelectorProps {
  value: string;
  onChange: (provider: string) => void;
}

export function TemplateProviderSelector({
  value,
  onChange,
}: TemplateProviderSelectorProps) {
  const { templates } = useTemplates();

  const providers = useMemo(() => {
    if (!templates) return [];
    const ownerSet = new Map<string, number>();
    for (const t of templates) {
      ownerSet.set(t.owner, (ownerSet.get(t.owner) ?? 0) + 1);
    }
    return [...ownerSet.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([addr, count]) => ({ address: addr, templateCount: count }));
  }, [templates]);

  return (
    <div>
      <label className="text-xs text-muted-foreground block mb-1">
        Template Provider
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-sm w-56 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="">All providers</option>
        {providers.map(({ address: addr, templateCount }) => (
          <option key={addr} value={addr}>
            {truncateAddress(addr)} ({templateCount} templates)
          </option>
        ))}
      </select>
    </div>
  );
}
