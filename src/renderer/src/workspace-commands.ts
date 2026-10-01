export const workspaceCommands = [
  {
    name: "ask",
    argument: "prompt",
    description: "Talk to your selected agent",
  },
  { name: "new", description: "Start a fresh conversation" },
  { name: "resume", argument: "last (optional)", description: "Resume a previous conversation" },
  { name: "discuss", description: "Switch to conversation with no tools" },
  {
    name: "run",
    argument: "command",
    description: "Run a shell command in this project",
  },
  { name: "plan", description: "Open the project brief" },
  { name: "build", description: "Return to the code editor" },
  {
    name: "research",
    argument: "URL (optional)",
    description: "Open research or visit a page",
  },
  { name: "open", description: "Choose a project folder" },
  { name: "attach", description: "Copy reference files into the project" },
  { name: "agents", description: "Choose a model or inspect connections" },
  { name: "terminal", description: "Open and focus the interactive shell" },
  { name: "stop", description: "Stop the current reply or command" },
  { name: "help", description: "List workspace commands" },
];
