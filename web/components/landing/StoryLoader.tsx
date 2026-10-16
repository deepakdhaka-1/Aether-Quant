"use client";

import dynamic from "next/dynamic";

const CandleStory = dynamic(() => import("./CandleStory"), {
  ssr: false,
  loading: () => <div className="min-h-[100vh]" aria-hidden />,
});

export default function StoryLoader() {
  return <CandleStory />;
}
