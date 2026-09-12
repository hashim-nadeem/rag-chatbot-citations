import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // readFileSync on data/*.json is invisible to Next's tracer; say so explicitly
  // or the vector store is missing from the deployed lambda.
  // Named explicitly rather than globbing data/** — that would also sweep the
  // multi-megabyte embed resume cache into the lambda when one exists locally.
  outputFileTracingIncludes: {
    "/api/chat": ["./data/vectors.json", "./data/canned.json"],
  },
};

export default nextConfig;
