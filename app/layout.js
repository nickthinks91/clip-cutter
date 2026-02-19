export const metadata = { title: "Clip Cutter", description: "Team clip selection tool" };
export default function RootLayout({ children }) {
  return <html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" /></head><body style={{ margin: 0, padding: 0, background: "#08080d", color: "#e8e8f0", overflowX: "hidden", width: "100%" }}>{children}</body></html>;
}
