import {
  executeRemoteMcpCallTool,
  executeRemoteMcpConfigure,
  executeRemoteMcpDisconnect,
  executeRemoteMcpListTools,
  executeRemoteMcpRemove,
  executeRemoteMcpStartOAuth,
  executeRemoteMcpStatus,
} from "../mcp"
import type { ToolExecutor } from "./types"

export const remoteMcpToolExecutors: Record<string, ToolExecutor> = {
  RemoteMcpStatus: executeRemoteMcpStatus,
  RemoteMcpConfigure: executeRemoteMcpConfigure,
  RemoteMcpStartOAuth: executeRemoteMcpStartOAuth,
  RemoteMcpDisconnect: executeRemoteMcpDisconnect,
  RemoteMcpRemove: executeRemoteMcpRemove,
  RemoteMcpListTools: executeRemoteMcpListTools,
  RemoteMcpCallTool: executeRemoteMcpCallTool,
}
