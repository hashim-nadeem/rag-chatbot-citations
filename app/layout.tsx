import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: "Cited — RAG over the IRS employer tax guides",
  description:
    "A retrieval-augmented chatbot that cites the exact source chunk for every claim and refuses to answer when the documents don't cover the question. Published eval score.",
};

/** Applied before first paint so an explicit theme choice never flashes. */
const NO_FLASH = `try{var t=localStorage.getItem("theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </head>
      <body className={`${inter.variable} ${mono.variable} antialiased`}>{children}</body>
    </html>
  );
}
