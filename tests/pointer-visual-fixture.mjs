export function createPointerMovementClickEvents() {
  return [
    {
      atMs: 100,
      button: 0,
      buttons: 0,
      frameId: "main",
      type: "move",
      x: 80,
      y: 90,
    },
    {
      atMs: 200,
      button: 0,
      buttons: 1,
      frameId: "main",
      type: "down",
      x: 80,
      y: 90,
    },
    {
      atMs: 500,
      button: 0,
      buttons: 0,
      frameId: "main",
      type: "move",
      x: 160,
      y: 90,
    },
    {
      atMs: 700,
      button: 0,
      buttons: 1,
      frameId: "main",
      type: "down",
      x: 160,
      y: 90,
    },
  ];
}
