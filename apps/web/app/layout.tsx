import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Realtime Sync Editor",
  description: "Distributed real-time collaborative editor (NestJS + NextJS)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="container">{children}</div>
      </body>
    </html>
  );
}

