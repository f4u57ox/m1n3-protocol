"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useTemplates } from "@/hooks/useTemplates";
import { truncateAddress } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const TemplateCompare = dynamic(
  () => import("@/components/TemplateCompare").then((m) => ({ default: m.TemplateCompare })),
  { loading: () => <div className="h-48 animate-pulse bg-muted rounded-lg" /> },
);

export function CompareTab() {
  const { templates, loading } = useTemplates();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleTemplate = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 4) {
        next.add(id);
      }
      return next;
    });
  };

  const selectedTemplates = templates.filter((t) => selectedIds.has(t.id));

  return (
    <div className="space-y-6">
      {/* Template Selector */}
      <Card>
        <CardHeader>
          <CardTitle>
            Select Templates ({selectedIds.size}/4)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-muted-foreground">Loading templates...</div>
          ) : templates.length === 0 ? (
            <div className="text-muted-foreground">No templates available</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => toggleTemplate(t.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm transition-colors ${
                    selectedIds.has(t.id)
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-card hover:bg-accent border-border"
                  }`}
                  disabled={!selectedIds.has(t.id) && selectedIds.size >= 4}
                >
                  <span className="font-mono">{truncateAddress(t.id)}</span>
                  <Badge variant="secondary" className="text-xs">
                    H:{t.height}
                  </Badge>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Comparison */}
      <TemplateCompare templates={selectedTemplates} />
    </div>
  );
}
