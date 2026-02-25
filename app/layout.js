export const metadata = { title: "Clip Cutter", description: "Team clip selection tool" };
export default function RootLayout({ children }) {
  return <html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" /><link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" /><link href="https://fonts.googleapis.com/css2?family=Permanent+Marker&family=DM+Sans:wght@300;400;500;600;700;800&family=Fredoka:wght@400;500;600;700&display=swap" rel="stylesheet" /></head><body style={{ margin: 0, padding: 0, background: "#1a1410", color: "#F5E6C8", overflowX: "hidden", width: "100%" }}>{children}</body></html>;
}
