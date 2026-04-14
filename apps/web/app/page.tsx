import Link from "next/link";

const DEMO_DOCS = [
  { id: "demo", label: "Getting started" },
  { id: "demo2", label: "Meeting notes" },
  { id: "demo3", label: "Project plan" },
];

function DocsIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect width="32" height="32" rx="4" fill="#4285F4" />
      <rect x="7" y="10" width="18" height="2.5" rx="1.25" fill="white" />
      <rect x="7" y="15" width="18" height="2.5" rx="1.25" fill="white" />
      <rect x="7" y="20" width="12" height="2.5" rx="1.25" fill="white" />
    </svg>
  );
}

export default function Home() {
  return (
    <div className="home-page">
      <header className="home-header">
        <DocsIcon />
        <span className="home-header-title">Docs</span>
      </header>

      <div className="home-body">
        <div className="home-section-title">
          <span>Recent documents</span>
        </div>

        <div className="home-doc-grid">
          {DEMO_DOCS.map((doc) => (
            <Link key={doc.id} href={`/doc/${doc.id}`} className="home-doc-card">
              <div className="home-doc-preview">
                <div className="home-doc-preview-lines">
                  <div className="home-doc-preview-line" />
                  <div className="home-doc-preview-line short" />
                  <div className="home-doc-preview-line" />
                  <div className="home-doc-preview-line shorter" />
                  <div className="home-doc-preview-line short" />
                </div>
              </div>
              <div className="home-doc-label">
                <DocsIcon />
                <div>
                  <div className="home-doc-label-text">{doc.label}</div>
                  <div className="home-doc-label-meta">Shared</div>
                </div>
              </div>
            </Link>
          ))}

          {/* New doc card */}
          <Link href="/doc/new" className="home-doc-card">
            <div className="home-doc-preview" style={{ background: "#f8f9fa" }}>
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                <circle cx="20" cy="20" r="20" fill="#e8f0fe" />
                <rect x="19" y="10" width="2" height="20" rx="1" fill="#1a73e8" />
                <rect x="10" y="19" width="20" height="2" rx="1" fill="#1a73e8" />
              </svg>
            </div>
            <div className="home-doc-label">
              <DocsIcon />
              <div>
                <div className="home-doc-label-text">Blank document</div>
                <div className="home-doc-label-meta">New</div>
              </div>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
