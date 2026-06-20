import { docs } from "@/.source";
import { loader } from "fumadocs-core/source";

const mdxSource = docs.toFumadocsSource();

// fumadocs-mdx@11 returns files as a getter function,
// fumadocs-core@15 expects a plain array — resolve the incompatibility
type S = typeof mdxSource;
const resolved: S = {
  files:
    typeof (mdxSource as any).files === "function"
      ? (mdxSource as any).files()
      : mdxSource.files,
};

export const source = loader({
  source: resolved,
  baseUrl: "/docs",
});
