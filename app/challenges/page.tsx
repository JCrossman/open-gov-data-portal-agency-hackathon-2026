export const revalidate = 3600;
import { getChallengeFindings } from "@/lib/findings";

const challenges = [
  {
    slug: "zombie-recipients",
    num: 1,
    title: "Zombie Recipients",
    desc: "Which companies and nonprofits received large amounts of public funding and then ceased operations shortly after?",
  },
  {
    slug: "ghost-capacity",
    num: 2,
    title: "Ghost Capacity",
    desc: "Which funded organizations show no evidence of actually being able to deliver what they were funded to do?",
  },
  {
    slug: "funding-loops",
    num: 3,
    title: "Funding Loops",
    desc: "Where does money flow in circles between charities, and does it matter?",
  },
  {
    slug: "amendment-creep",
    num: 4,
    title: "Sole Source & Amendment Creep",
    desc: "Which contracts started small and competitive but grew large through sole-source amendments?",
  },
  {
    slug: "vendor-concentration",
    num: 5,
    title: "Vendor Concentration",
    desc: "In any given category of government spending, how many vendors are actually competing?",
  },
  {
    slug: "related-parties",
    num: 6,
    title: "Related Parties & Governance Networks",
    desc: "Who controls the entities that receive public money, and do they also control each other?",
  },
  {
    slug: "policy-misalignment",
    num: 7,
    title: "Policy Misalignment",
    desc: "Is the money going where the government says its priorities are?",
  },
  {
    slug: "duplicative-funding",
    num: 8,
    title: "Duplicative Funding & Gaps",
    desc: "Which organizations are funded by multiple departments for the same purpose?",
  },
  {
    slug: "contract-intelligence",
    num: 9,
    title: "Contract Intelligence",
    desc: "What is Canada actually buying, and is it paying more over time?",
  },
  {
    slug: "adverse-media",
    num: 10,
    title: "Adverse Media",
    desc: "Which funding recipients are the subject of serious adverse media coverage?",
  },
];

export default async function ChallengesHubPage() {
  const findings = await getChallengeFindings();

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "1.5rem" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>
        10 Accountability Challenges
      </h1>
      <p
        style={{
          color: "var(--gc-text-secondary)",
          marginBottom: "2rem",
          maxWidth: 720,
        }}
      >
        Each challenge targets a specific failure mode in public spending,
        querying 3M+ federal records in real time from{" "}
        <a href="https://open.canada.ca" style={{ color: "#0b3d68", textDecoration: "underline", fontWeight: 600 }}>
          open.canada.ca
        </a>
        . Click any challenge to see the full analysis.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
          gap: "1.25rem",
        }}
      >
        {challenges.map((c) => {
          const finding = findings[c.slug] ?? "Data unavailable";
          return (
            <a
              key={c.slug}
              href={`/challenges/${c.slug}`}
              style={{
                display: "block",
                background: "var(--gc-bg-secondary)",
                borderRadius: "8px",
                padding: "1.5rem",
                textDecoration: "none",
                color: "var(--gc-text)",
                border: "1px solid var(--gc-border)",
                transition: "box-shadow 0.15s ease, border-color 0.15s ease",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", marginBottom: "0.75rem" }}>
                <span
                  className="font-mono"
                  style={{
                    background: "var(--gc-accent)",
                    color: "white",
                    borderRadius: "4px",
                    padding: "0.15rem 0.6rem",
                    fontSize: "0.8rem",
                    fontWeight: 700,
                  }}
                >
                  {c.num}
                </span>
                <h2 style={{ fontSize: "1.25rem", margin: 0, color: "var(--gc-primary)" }}>
                  {c.title}
                </h2>
              </div>
              <p style={{ fontSize: "0.875rem", color: "var(--gc-text-secondary)", margin: "0 0 1rem" }}>
                {c.desc}
              </p>
              <div
                style={{
                  fontSize: "0.8125rem",
                  fontWeight: 600,
                  color: "var(--gc-secondary)",
                  borderTop: "1px solid var(--gc-border)",
                  paddingTop: "0.75rem",
                }}
              >
                Live signal: {finding}
              </div>
              <div
                style={{
                  marginTop: "0.75rem",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  color: "var(--gc-accent)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                View Analysis &rarr;
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
