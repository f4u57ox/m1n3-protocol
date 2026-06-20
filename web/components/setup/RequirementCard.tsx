import { type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

interface RequirementCardProps {
  icon: ReactNode;
  name: string;
  description: string;
  required: boolean;
  link?: string;
}

export function RequirementCard({
  icon,
  name,
  description,
  required,
  link,
}: RequirementCardProps) {
  return (
    <div className="flex items-start gap-3 rounded-md border p-3">
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-2">
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium underline underline-offset-4 hover:text-primary"
            >
              {name}
            </a>
          ) : (
            <span className="text-sm font-medium">{name}</span>
          )}
          <Badge variant={required ? "default" : "secondary"}>
            {required ? "Required" : "Optional"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
