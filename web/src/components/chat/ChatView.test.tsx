import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ChatView } from "@/components/chat/ChatView";
import { mockMessageList } from "@/test/mockApi";

const { mockApi, ApiError } = vi.hoisted(() => ({
  mockApi: {
    getStatus: vi.fn(), listSessions: vi.fn(), createSession: vi.fn(),
    getSession: vi.fn(), deleteSession: vi.fn(), listMessages: vi.fn(),
    interruptChat: vi.fn(), chat: vi.fn(), listTools: vi.fn(), getTool: vi.fn(), approveTool: vi.fn(),
    revokeTool: vi.fn(), deleteTool: vi.fn(), listSecrets: vi.fn(),
    setSecret: vi.fn(), deleteSecret: vi.fn(), listSchedules: vi.fn(),
    createSchedule: vi.fn(), enableSchedule: vi.fn(), disableSchedule: vi.fn(),
    deleteSchedule: vi.fn(), getSystemPrompt: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status: number; detail: unknown;
    constructor(s: number, d: unknown) {
      const m = typeof d === "string" ? d : (d as { message?: string })?.message || `HTTP ${s}`;
      super(m); this.name = "ApiError"; this.status = s; this.detail = d;
    }
  },
}));
vi.mock("@/lib/api", () => ({ api: mockApi, ApiError }));

import { api } from "@/lib/api";

function renderChatView(sessionId: string = "abc123") {
  return render(
    <MemoryRouter initialEntries={[`/sessions/${sessionId}`]}>
      <Routes>
        <Route path="/sessions/:id" element={<ChatView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ChatView", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    api.listMessages.mockResolvedValue(mockMessageList);
    api.chat.mockResolvedValue(undefined);
  });

  it("shows loading state initially", () => {
    renderChatView();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("loads and displays message history", async () => {
    renderChatView();
    await waitFor(() => expect(screen.getByText("Hello there")).toBeInTheDocument());
    expect(screen.getByText("Hi! How can I help?")).toBeInTheDocument();
  });

  it("shows empty state when no messages", async () => {
    api.listMessages.mockResolvedValue({ messages: [], cursor: null });
    renderChatView();
    await waitFor(() => expect(screen.getByText(/Send a message to start chatting/)).toBeInTheDocument());
  });

  it("filters out structured tool turns that carry no displayable text", async () => {
    api.listMessages.mockResolvedValue({
      messages: [
        { id: 1, sender: "user", content: JSON.stringify({ role: "user", content: "do a thing" }) },
        {
          id: 2,
          sender: "assistant",
          content: JSON.stringify({
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "execute_code", input: { code: "x" } }],
          }),
        },
        {
          id: 3,
          sender: "user",
          content: JSON.stringify({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          }),
        },
        {
          id: 4,
          sender: "assistant",
          content: JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "all done" }],
          }),
        },
      ],
      cursor: null,
    });
    renderChatView();
    await waitFor(() => expect(screen.getByText("do a thing")).toBeInTheDocument());
    expect(screen.getByText("all done")).toBeInTheDocument();
    // The tool_use-only and tool_result turns render no empty bubbles.
    const bubbles = screen.getAllByText(/do a thing|all done/);
    expect(bubbles).toHaveLength(2);
  });

  it("keeps input enabled and shows thinking state while responding", async () => {
    api.chat.mockReturnValue(new Promise(() => {}));
    renderChatView();
    await waitFor(() => expect(screen.getByPlaceholderText("Type a message…")).toBeInTheDocument());
    const input = screen.getByPlaceholderText("Type a message…");
    fireEvent.change(input, { target: { value: "test message" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(screen.getByText("Thinking…")).toBeInTheDocument());
    expect(input).toBeEnabled();
  });

  it("shows user message immediately after sending", async () => {
    renderChatView();
    await waitFor(() => expect(screen.getByPlaceholderText("Type a message…")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), { target: { value: "my new message" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(screen.getByText("my new message")).toBeInTheDocument());
  });

  it("handles SSE response event and shows assistant message", async () => {
    let cb: ((e: string, d: Record<string, unknown>) => void) | null = null;
    api.chat.mockImplementation((_s: string, _m: string, _i: unknown, onEvent?: (e: string, d: Record<string, unknown>) => void) => {
      cb = onEvent || null;
      return Promise.resolve();
    });
    renderChatView();
    await waitFor(() => expect(screen.getByPlaceholderText("Type a message…")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), { target: { value: "hello agent" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(cb).not.toBeNull());
    act(() => { cb!("response", { text: "Here is my reply" }); });
    await waitFor(() => expect(screen.getByText("Here is my reply")).toBeInTheDocument());
  });

  it("handles SSE error event", async () => {
    let cb: ((e: string, d: Record<string, unknown>) => void) | null = null;
    api.chat.mockImplementation((_s: string, _m: string, _i: unknown, onEvent?: (e: string, d: Record<string, unknown>) => void) => {
      cb = onEvent || null;
      return Promise.resolve();
    });
    renderChatView();
    await waitFor(() => expect(screen.getByPlaceholderText("Type a message…")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), { target: { value: "hi" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(cb).not.toBeNull());
    act(() => { cb!("error", { message: "Something broke" }); });
    await waitFor(() => expect(screen.getByText("Something broke")).toBeInTheDocument());
  });

  it("handles tool_start and tool_done events", async () => {
    let cb: ((e: string, d: Record<string, unknown>) => void) | null = null;
    api.chat.mockImplementation((_s: string, _m: string, _i: unknown, onEvent?: (e: string, d: Record<string, unknown>) => void) => {
      cb = onEvent || null;
      return Promise.resolve();
    });
    renderChatView();
    await waitFor(() => expect(screen.getByPlaceholderText("Type a message…")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), { target: { value: "use a tool" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(cb).not.toBeNull());
    act(() => { cb!("tool_start", { tool: "execute_code", code: "const x = 1;" }); });
    await waitFor(() => {
      expect(screen.getByText("execute_code")).toBeInTheDocument();
      expect(screen.getByText("running…")).toBeInTheDocument();
    });
    expect(screen.getByText(/Running: execute_code/)).toBeInTheDocument();
    act(() => { cb!("tool_done", { tool: "execute_code", result: { output: 42 }, success: true }); });
    await waitFor(() => expect(screen.queryByText("running…")).not.toBeInTheDocument());
  });

  it("updates token stats on llm_done event", async () => {
    let cb: ((e: string, d: Record<string, unknown>) => void) | null = null;
    api.chat.mockImplementation((_s: string, _m: string, _i: unknown, onEvent?: (e: string, d: Record<string, unknown>) => void) => {
      cb = onEvent || null;
      return Promise.resolve();
    });
    renderChatView();
    await waitFor(() => expect(screen.getByPlaceholderText("Type a message…")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), { target: { value: "hi" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(cb).not.toBeNull());
    act(() => { cb!("llm_start", {}); });
    act(() => { cb!("llm_done", { usage: { input_tokens: 100, output_tokens: 50 } }); });
    await waitFor(() => {
      expect(screen.getByText(/in:.*100/)).toBeInTheDocument();
      expect(screen.getByText(/out:.*50/)).toBeInTheDocument();
      expect(screen.getByText(/calls:.*1/)).toBeInTheDocument();
    });
  });

  it("does not send empty messages", async () => {
    renderChatView();
    await waitFor(() => expect(screen.getByText("Send")).toBeInTheDocument());
    expect(screen.getByText("Send")).toBeDisabled();
  });

  it("sends on Enter key press", async () => {
    renderChatView();
    await waitFor(() => expect(screen.getByPlaceholderText("Type a message…")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), { target: { value: "enter test" } });
    fireEvent.keyDown(screen.getByPlaceholderText("Type a message…"), { key: "Enter", shiftKey: false });
    await waitFor(() => expect(api.chat).toHaveBeenCalled());
  });

  it("does not send on Shift+Enter", async () => {
    renderChatView();
    await waitFor(() => expect(screen.getByPlaceholderText("Type a message…")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), { target: { value: "shift enter test" } });
    fireEvent.keyDown(screen.getByPlaceholderText("Type a message…"), { key: "Enter", shiftKey: true });
    expect(api.chat).not.toHaveBeenCalled();
  });
});


it("queues follow-ups through LLM transitions and sends them in order", async () => {
  sessionStorage.clear();
  vi.clearAllMocks();
  api.listMessages.mockResolvedValue(mockMessageList);
  const finishes: (() => void)[] = [];
  let event!: (e: string, d: Record<string, unknown>) => void;
  api.chat.mockImplementation((_s, _m, _i, cb) => {
    event = cb;
    return new Promise<void>(resolve => finishes.push(resolve));
  });
  renderChatView();
  await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
  const send = (text: string) => {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  };
  send("first");
  act(() => event("llm_done", {}));
  send("second");
  send("third");
  expect(api.chat).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Queue message")).toBeInTheDocument();
  await act(async () => finishes[0]());
  expect(api.chat.mock.calls[1][1]).toBe("second");
  await act(async () => finishes[1]());
  expect(api.chat.mock.calls[2][1]).toBe("third");
  await act(async () => finishes[2]());
  expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
});

it("waits for interruption and stream completion before prioritizing new context", async () => {
  sessionStorage.clear();
  vi.clearAllMocks();
  api.listMessages.mockResolvedValue(mockMessageList);
  let finish!: () => void;
  let acknowledge!: () => void;
  api.chat.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  api.interruptChat.mockReturnValue(new Promise(resolve => { acknowledge = () => resolve({ interrupted: true }); }));
  renderChatView();
  await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "first" } });
  fireEvent.click(screen.getByText("Send"));
  fireEvent.change(input, { target: { value: "queued" } });
  fireEvent.click(screen.getByText("Queue message"));
  fireEvent.change(input, { target: { value: "new context" } });
  fireEvent.click(screen.getByText("Interrupt and send"));
  expect(api.interruptChat).toHaveBeenCalledWith("abc123");
  await act(async () => acknowledge());
  expect(api.chat).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(api.chat.mock.calls.map(call => call[1])).toEqual(["first", "new context", "queued"]);
});

it("keeps the draft when interruption fails", async () => {
  sessionStorage.clear();
  vi.clearAllMocks();
  api.listMessages.mockResolvedValue(mockMessageList);
  api.chat.mockReturnValue(new Promise(() => {}));
  api.interruptChat.mockRejectedValue(new Error("offline"));
  renderChatView();
  await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "first" } });
  fireEvent.click(screen.getByText("Send"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "keep this" } });
  fireEvent.click(screen.getByText("Interrupt and send"));
  await screen.findByText("Could not interrupt agent: offline");
  expect(screen.getByRole("textbox")).toHaveValue("keep this");
  expect(api.chat).toHaveBeenCalledTimes(1);
});

it("restores pending follow-ups for the same session without sending automatically", async () => {
  vi.clearAllMocks();
  sessionStorage.setItem("chat-queue:abc123", JSON.stringify(["saved follow-up"]));
  api.listMessages.mockResolvedValue(mockMessageList);
  api.chat.mockResolvedValue(undefined);
  renderChatView();
  await screen.findByText("saved follow-up");
  await waitFor(() => expect(screen.getByText("Resume queued messages")).toBeEnabled());
  expect(api.chat).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Resume queued messages"));
  await waitFor(() => expect(api.chat).toHaveBeenCalledWith("abc123", "saved follow-up", undefined, expect.any(Function), expect.any(AbortSignal)));
  expect(sessionStorage.getItem("chat-queue:abc123")).toBeNull();
});
