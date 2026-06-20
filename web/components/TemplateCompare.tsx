"use client";

import { useMemo } from "react";
import type { TemplateData } from "@/lib/types";
import { truncateAddress, formatHex, formatM1N3 } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface TemplateCompareProps {
  templates: TemplateData[];
}

export function TemplateCompare({ templates }: TemplateCompareProps) {
  // Find shared, partial, and unique merkle branches
  const merkleAnalysis = useMemo(() => {
    if (templates.length < 2) return { shared: [], partial: [], unique: new Map<string, string[]>() };

    const branchSets = templates.map((t) => new Set(t.merkleBranches));
    const allBranches = new Set(templates.flatMap((t) => t.merkleBranches));

    const shared: string[] = [];
    const partial: string[] = [];
    const unique = new Map<string, string[]>();

    templates.forEach((t) => {
      unique.set(t.id, []);
    });

    allBranches.forEach((branch) => {
      const count = branchSets.filter((s) => s.has(branch)).length;
      if (count === templates.length) {
        shared.push(branch);
      } else if (count > 1) {
        partial.push(branch);
      } else {
        // Find which template has it
        templates.forEach((t, i) => {
          if (branchSets[i].has(branch)) {
            unique.get(t.id)!.push(branch);
          }
        });
      }
    });

    return { shared, partial, unique };
  }, [templates]);

  if (templates.length < 2) {
    return (
      <div className="text-center text-muted-foreground py-8">
        Select at least 2 templates to compare
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Field Comparison */}
      <Card>
        <CardHeader>
          <CardTitle>Header Fields</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 pr-4 text-muted-foreground font-medium">
                    Field
                  </th>
                  {templates.map((t) => (
                    <th
                      key={t.id}
                      className="text-left py-2 px-4 font-medium font-mono"
                    >
                      {truncateAddress(t.id)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <CompareRow
                  label="Height"
                  values={templates.map((t) => t.height.toLocaleString())}
                />
                <CompareRow
                  label="Version"
                  values={templates.map(
                    (t) => `0x${t.version.toString(16).padStart(8, "0")}`
                  )}
                />
                <CompareRow
                  label="nBits"
                  values={templates.map(
                    (t) => `0x${t.nbits.toString(16).padStart(8, "0")}`
                  )}
                />
                <CompareRow
                  label="Shares"
                  values={templates.map((t) => t.shareCount.toLocaleString())}
                />
                <CompareRow
                  label="Staked"
                  values={templates.map(
                    (t) =>
                      `${t.stakedAmount ? formatM1N3(t.stakedAmount) : "0"} m1n3`
                  )}
                />
                <CompareRow
                  label="Owner"
                  values={templates.map((t) => truncateAddress(t.owner))}
                />
                <CompareRow
                  label="Status"
                  values={templates.map((t) =>
                    t.isActive ? "Active" : "Inactive"
                  )}
                />
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Merkle Branch Analysis */}
      <Card>
        <CardHeader>
          <CardTitle>Merkle Branch Analysis</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4 text-sm">
            <Badge variant="default" className="bg-green-600">
              Shared: {merkleAnalysis.shared.length}
            </Badge>
            <Badge variant="secondary" className="bg-yellow-600 text-white">
              Partial: {merkleAnalysis.partial.length}
            </Badge>
            <Badge variant="destructive">
              Unique:{" "}
              {Array.from(merkleAnalysis.unique.values()).reduce(
                (a, b) => a + b.length,
                0
              )}
            </Badge>
          </div>

          {merkleAnalysis.shared.length > 0 && (
            <div>
              <p className="text-sm font-medium text-green-600 dark:text-green-400 mb-1">
                Shared (all templates)
              </p>
              {merkleAnalysis.shared.map((b, i) => (
                <code
                  key={i}
                  className="block text-xs font-mono bg-green-500/10 rounded px-2 py-1 mb-1 break-all"
                >
                  {formatHex(b, 64)}
                </code>
              ))}
            </div>
          )}

          {merkleAnalysis.partial.length > 0 && (
            <div>
              <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400 mb-1">
                Partial (some templates)
              </p>
              {merkleAnalysis.partial.map((b, i) => (
                <code
                  key={i}
                  className="block text-xs font-mono bg-yellow-500/10 rounded px-2 py-1 mb-1 break-all"
                >
                  {formatHex(b, 64)}
                </code>
              ))}
            </div>
          )}

          {templates.map((t) => {
            const uBranches = merkleAnalysis.unique.get(t.id) || [];
            if (uBranches.length === 0) return null;
            return (
              <div key={t.id}>
                <p className="text-sm font-medium text-red-600 dark:text-red-400 mb-1">
                  Unique to {truncateAddress(t.id)}
                </p>
                {uBranches.map((b, i) => (
                  <code
                    key={i}
                    className="block text-xs font-mono bg-red-500/10 rounded px-2 py-1 mb-1 break-all"
                  >
                    {formatHex(b, 64)}
                  </code>
                ))}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Coinbase Diff */}
      <Card>
        <CardHeader>
          <CardTitle>Coinbase Comparison</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {templates.map((t) => (
            <div key={t.id} className="space-y-1">
              <p className="text-sm font-medium font-mono">
                {truncateAddress(t.id)}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-xs text-muted-foreground">CB1</p>
                  <code className="block text-xs font-mono bg-muted rounded px-2 py-1 break-all">
                    {t.coinbase1 || "(empty)"}
                  </code>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">CB2</p>
                  <code className="block text-xs font-mono bg-muted rounded px-2 py-1 break-all">
                    {t.coinbase2 || "(empty)"}
                  </code>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Staking Bar Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Stake Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {templates.map((t) => {
              const staked = t.stakedAmount || 0;
              const maxStake = Math.max(
                ...templates.map((tt) => tt.stakedAmount || 0),
                1
              );
              const pct = (staked / maxStake) * 100;

              return (
                <div key={t.id} className="flex items-center gap-3">
                  <span className="text-xs font-mono w-24 shrink-0">
                    {truncateAddress(t.id)}
                  </span>
                  <div className="flex-1 bg-muted rounded-full h-5 overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono w-20 text-right">
                    {formatM1N3(staked)}
                  </span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CompareRow({
  label,
  values,
}: {
  label: string;
  values: string[];
}) {
  const allSame = values.every((v) => v === values[0]);

  return (
    <tr className="border-b last:border-0">
      <td className="py-2 pr-4 text-muted-foreground">{label}</td>
      {values.map((v, i) => (
        <td
          key={i}
          className={`py-2 px-4 font-mono text-xs ${
            !allSame ? "bg-yellow-500/5 font-medium" : ""
          }`}
        >
          {v}
        </td>
      ))}
    </tr>
  );
}
