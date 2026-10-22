import { forwardRef } from "react";
import { fmtCorr, fmtDateTime, fmtDeltaWords, fmtLufs, fmtPeak, fmtSigned } from "../../lib/format";
import type { PlatformResult } from "../../lib/types";

export interface ReportContourPoint {
  t: number;
  m: number | null;
  s: number | null;
}

export interface SessionReportData {
  title: string;
  subtitle: string;
  timestamp: Date;
  integrated: number | null;
  tpMax: number | null;
  shortTermMax: number | null;
  momentaryMax: number | null;
  lra: number | null;
  psr: number | null;
  plr: number | null;
  correlation: number;
  targetName: string;
  targetLufs: number;
  contour: ReportContourPoint[];
  platforms: PlatformResult[];
}

function buildSvgPath(
  pts: ReportContourPoint[],
  pick: (p: ReportContourPoint) => number | null,
  w: number,
  h: number,
  yMin: number,
  yMax: number,
): string {
  if (pts.length === 0) return "";
  const n = pts.length;
  const parts: string[] = [];
  let penDown = false;
  for (let i = 0; i < n; i++) {
    const v = pick(pts[i]);
    if (v === null || !Number.isFinite(v)) {
      penDown = false;
      continue;
    }
    const x = n === 1 ? w * 0.5 : (i / (n - 1)) * w;
    const clamped = Math.max(yMin, Math.min(yMax, v));
    const y = h - ((clamped - yMin) / (yMax - yMin)) * (h - 24) - 12;
    parts.push(`${penDown ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`);
    penDown = true;
  }
  return parts.join(" ");
}

export const SessionReportCard = forwardRef<HTMLDivElement, { data: SessionReportData }>(
  function SessionReportCard({ data }, ref) {
    const svgW = 896;
    const svgH = 170;
    const yMin = -36;
    const yMax = 0;
    const stPath = buildSvgPath(data.contour, (p) => p.s ?? p.m, svgW, svgH, yMin, yMax);
    const mPath = buildSvgPath(data.contour, (p) => p.m, svgW, svgH, yMin, yMax);
    const tgtY =
      svgH - ((Math.max(yMin, Math.min(yMax, data.targetLufs)) - yMin) / (yMax - yMin)) * (svgH - 24) - 12;

    return (
      <div
        ref={ref}
        style={{
          width: "960px",
          background: "linear-gradient(180deg, #13151A 0%, #0E1014 100%)",
          color: "#E8E9EC",
          fontFamily: 'Inter, "Segoe UI Variable", "Segoe UI", sans-serif',
          padding: "32px",
          border: "1px solid #26282E",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid #26282E",
            paddingBottom: "18px",
            marginBottom: "22px",
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                fontSize: "12px",
                fontWeight: 800,
                letterSpacing: "0.14em",
                color: "#10B981",
              }}
            >
              <span>ARES LOUDNESS METER · SESSION REPORT</span>
            </div>
            <div style={{ fontSize: "22px", fontWeight: 800, marginTop: "4px", color: "#FFFFFF" }}>
              {data.title}
            </div>
            <div style={{ fontSize: "12px", color: "#8A8F98", marginTop: "2px" }}>{data.subtitle}</div>
          </div>
          <div style={{ textAlign: "right", fontSize: "12px", color: "#8A8F98" }}>
            <div style={{ fontWeight: 700, color: "#E8E9EC" }}>{fmtDateTime(data.timestamp)}</div>
            <div style={{ marginTop: "3px" }}>ITU-R BS.1770-5 · EBU R128</div>
          </div>
        </div>

        {/* Metric Tiles */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "12px",
            marginBottom: "18px",
          }}
        >
          <div style={{ background: "#1A1C20", border: "1px solid #26282E", borderRadius: "12px", padding: "14px" }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: "#8A8F98", letterSpacing: "0.08em" }}>
              INTEGRATED LOUDNESS
            </div>
            <div style={{ fontSize: "28px", fontWeight: 800, color: "#FF3B5C", marginTop: "6px" }}>
              {fmtLufs(data.integrated)} <span style={{ fontSize: "12px", color: "#8A8F98" }}>LUFS</span>
            </div>
          </div>

          <div style={{ background: "#1A1C20", border: "1px solid #26282E", borderRadius: "12px", padding: "14px" }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: "#8A8F98", letterSpacing: "0.08em" }}>
              TRUE PEAK (MAX)
            </div>
            <div style={{ fontSize: "28px", fontWeight: 800, color: "#FF7A00", marginTop: "6px" }}>
              {fmtPeak(data.tpMax)} <span style={{ fontSize: "12px", color: "#8A8F98" }}>dBTP</span>
            </div>
          </div>

          <div style={{ background: "#1A1C20", border: "1px solid #26282E", borderRadius: "12px", padding: "14px" }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: "#8A8F98", letterSpacing: "0.08em" }}>
              SHORT-TERM MAX
            </div>
            <div style={{ fontSize: "28px", fontWeight: 800, color: "#FF3B5C", marginTop: "6px" }}>
              {fmtLufs(data.shortTermMax)} <span style={{ fontSize: "12px", color: "#8A8F98" }}>LUFS</span>
            </div>
          </div>

          <div style={{ background: "#1A1C20", border: "1px solid #26282E", borderRadius: "12px", padding: "14px" }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: "#8A8F98", letterSpacing: "0.08em" }}>
              MOMENTARY MAX
            </div>
            <div style={{ fontSize: "28px", fontWeight: 800, color: "#FF3B5C", marginTop: "6px" }}>
              {fmtLufs(data.momentaryMax)} <span style={{ fontSize: "12px", color: "#8A8F98" }}>LUFS</span>
            </div>
          </div>

          <div style={{ background: "#1A1C20", border: "1px solid #26282E", borderRadius: "12px", padding: "14px" }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: "#8A8F98", letterSpacing: "0.08em" }}>
              LOUDNESS RANGE (LRA)
            </div>
            <div style={{ fontSize: "24px", fontWeight: 800, color: "#10B981", marginTop: "6px" }}>
              {fmtLufs(data.lra)} <span style={{ fontSize: "12px", color: "#8A8F98" }}>LU</span>
            </div>
          </div>

          <div style={{ background: "#1A1C20", border: "1px solid #26282E", borderRadius: "12px", padding: "14px" }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: "#8A8F98", letterSpacing: "0.08em" }}>
              PSR (PEAK-TO-SHORT-TERM)
            </div>
            <div style={{ fontSize: "24px", fontWeight: 800, color: "#10B981", marginTop: "6px" }}>
              {fmtLufs(data.psr)} <span style={{ fontSize: "12px", color: "#8A8F98" }}>LU</span>
            </div>
          </div>

          <div style={{ background: "#1A1C20", border: "1px solid #26282E", borderRadius: "12px", padding: "14px" }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: "#8A8F98", letterSpacing: "0.08em" }}>
              PLR (PEAK-TO-LOUDNESS)
            </div>
            <div style={{ fontSize: "24px", fontWeight: 800, color: "#10B981", marginTop: "6px" }}>
              {fmtLufs(data.plr)} <span style={{ fontSize: "12px", color: "#8A8F98" }}>LU</span>
            </div>
          </div>

          <div style={{ background: "#1A1C20", border: "1px solid #26282E", borderRadius: "12px", padding: "14px" }}>
            <div style={{ fontSize: "10px", fontWeight: 700, color: "#8A8F98", letterSpacing: "0.08em" }}>
              STEREO CORRELATION
            </div>
            <div style={{ fontSize: "24px", fontWeight: 800, color: "#10B981", marginTop: "6px" }}>
              {fmtCorr(data.correlation)}
            </div>
          </div>
        </div>

        {/* Loudness Contour SVG */}
        <div
          style={{
            background: "#1A1C20",
            border: "1px solid #26282E",
            borderRadius: "12px",
            padding: "14px",
            marginBottom: "18px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "10px",
              fontWeight: 700,
              color: "#8A8F98",
              letterSpacing: "0.08em",
              marginBottom: "8px",
            }}
          >
            <span>LOUDNESS CONTOUR (SHORT-TERM & MOMENTARY)</span>
            <span>
              REFERENCE TARGET: {data.targetName.toUpperCase()} ({data.targetLufs.toFixed(1)} LUFS)
            </span>
          </div>
          <svg
            width={svgW}
            height={svgH}
            viewBox={`0 0 ${svgW} ${svgH}`}
            style={{ display: "block", background: "#121418", borderRadius: "8px" }}
          >
            {[-6, -14, -23, -32].map((db) => {
              const y = svgH - ((db - yMin) / (yMax - yMin)) * (svgH - 24) - 12;
              return (
                <g key={db}>
                  <line x1={0} y1={y} x2={svgW} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
                  <text x={8} y={y - 4} fill="#8A8F98" fontSize={10}>
                    {db} LUFS
                  </text>
                </g>
              );
            })}
            <line
              x1={0}
              y1={tgtY}
              x2={svgW}
              y2={tgtY}
              stroke="#10B981"
              strokeWidth={1.4}
              strokeDasharray="6 4"
            />
            {mPath && <path d={mPath} fill="none" stroke="rgba(16,185,129,0.45)" strokeWidth={1.3} />}
            {stPath && <path d={stPath} fill="none" stroke="#FF3B5C" strokeWidth={2.2} />}
          </svg>
        </div>

        {/* Platform Normalization Simulator Table */}
        <div
          style={{
            background: "#1A1C20",
            border: "1px solid #26282E",
            borderRadius: "12px",
            padding: "14px",
          }}
        >
          <div
            style={{
              fontSize: "10px",
              fontWeight: 700,
              color: "#8A8F98",
              letterSpacing: "0.08em",
              marginBottom: "10px",
            }}
          >
            STREAMING & BROADCAST NORMALIZATION SIMULATOR
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr style={{ color: "#8A8F98", textAlign: "left", borderBottom: "1px solid #26282E" }}>
                <th style={{ padding: "6px 8px" }}>Platform</th>
                <th style={{ padding: "6px 8px" }}>Target</th>
                <th style={{ padding: "6px 8px" }}>Ceiling</th>
                <th style={{ padding: "6px 8px" }}>Delta</th>
                <th style={{ padding: "6px 8px" }}>Playback Gain</th>
                <th style={{ padding: "6px 8px" }}>Resulting TP</th>
                <th style={{ padding: "6px 8px" }}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {data.platforms.map((p) => {
                const dotColor =
                  p.status === "green" ? "#10B981" : p.status === "yellow" ? "#F59E0B" : "#EF4444";
                return (
                  <tr key={p.id} style={{ borderBottom: "1px solid rgba(38,40,46,0.55)" }}>
                    <td style={{ padding: "7px 8px", fontWeight: 700 }}>
                      <span
                        style={{
                          display: "inline-block",
                          width: "8px",
                          height: "8px",
                          borderRadius: "99px",
                          background: dotColor,
                          marginRight: "8px",
                        }}
                      />
                      {p.name}
                    </td>
                    <td style={{ padding: "7px 8px", color: "#8A8F98" }}>{p.targetLufs.toFixed(1)} LUFS</td>
                    <td style={{ padding: "7px 8px", color: "#8A8F98" }}>{p.tpCeiling.toFixed(1)} dBTP</td>
                    <td style={{ padding: "7px 8px", fontWeight: 600 }}>{fmtDeltaWords(p.delta)}</td>
                    <td style={{ padding: "7px 8px", fontWeight: 700, color: "#10B981" }}>
                      {fmtSigned(p.gain)} dB
                    </td>
                    <td style={{ padding: "7px 8px", color: "#FF7A00", fontWeight: 600 }}>
                      {Number.isFinite(p.resultingTp) ? `${p.resultingTp.toFixed(1)} dBTP` : "—"}
                    </td>
                    <td style={{ padding: "7px 8px", color: "#8A8F98" }}>{p.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div
          style={{
            marginTop: "14px",
            display: "flex",
            justifyContent: "space-between",
            fontSize: "11px",
            color: "#8A8F98",
          }}
        >
          <span>Generated by ARES Loudness Meter</span>
          <span>ITU-R BS.1770-5 · EBU Tech 3341/3342</span>
        </div>
      </div>
    );
  },
);
