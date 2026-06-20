"use client";

import { useParams } from "next/navigation";
import { useSuiQuery } from "@/hooks/useSuiQuery";
import { fetchTemplateById } from "@/lib/sui-queries";
import { TemplateCard } from "@/components/TemplateCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function TemplateDetailContent() {
  const params = useParams();
  const templateId = params.templateId as string;

  const { data: template, isLoading, error } = useSuiQuery(
    ["template", templateId],
    () => fetchTemplateById(templateId)
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 bg-muted rounded w-64 animate-pulse" />
        <div className="h-96 bg-muted rounded animate-pulse" />
      </div>
    );
  }

  if (error || !template) {
    return (
      <div className="space-y-4">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Dashboard
        </Link>
        <div className="rounded-lg border bg-destructive/10 p-8 text-center text-destructive">
          Template not found: {templateId}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <h1 className="text-2xl font-bold">Template Detail</h1>
      </div>

      <TemplateCard template={template} />

      <Card>
        <CardHeader>
          <CardTitle>Stake on this Template</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Staking is performed on-chain via the m1n3_v4 Sui contracts. Connect a
          Sui wallet and use the marketplace tools to stake on this template.
        </CardContent>
      </Card>
    </div>
  );
}
