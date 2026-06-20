"use client";

import { Suspense } from "react";
import { CompareTab } from "@/components/templates/CompareTab";

function TemplatesPageContent() {
  return (
    <>
      <title>m1n3 — Templates</title>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Templates</h1>
          <p className="text-muted-foreground">
            Block templates define which Bitcoin transactions miners work on — compare side-by-side
          </p>
        </div>

        <CompareTab />
      </div>
    </>
  );
}

export default function TemplatesPage() {
  return (
    <Suspense>
      <TemplatesPageContent />
    </Suspense>
  );
}
