// Lets BackupStory import the website screenshot (.webp) and Charles's photos (.jpg).
declare module '*.webp' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}
