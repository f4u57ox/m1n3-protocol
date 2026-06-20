import { type ReactNode } from "react";

interface StepCardProps {
  step: number;
  title: string;
  children: ReactNode;
}

export function StepCard({ step, title, children }: StepCardProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
          {step}
        </span>
        <p className="font-medium">{title}</p>
      </div>
      <div className="pl-9 text-sm text-muted-foreground space-y-2">
        {children}
      </div>
    </div>
  );
}
