/**
 * Changing the model, or one of its controls, of an agent that is already
 * running. It belongs to the adapter: the command that switches a model in one
 * TUI opens a picker in another and is ordinary prose to a third, so neither a
 * host nor a view may assume one.
 *
 * One request changes one thing. An agent may answer a switch with a
 * confirmation of its own, and a second command typed behind the first would
 * land in that dialog.
 */

/** One change: the model, or one control of the model that is serving now. */
export type AgentModelSwitchRequest =
  | {
      kind: 'model';
      /** The model, as the agent's own catalog names it (`AgentModelChoice.id`). */
      modelId: string;
    }
  | {
      kind: 'control';
      /** The control, as the catalog names it (`AgentModelControl.id`). */
      controlId: string;
      /** One of that control's own values (`AgentModelControl.values[].id`). */
      value: string;
    };

/**
 * `sent` = the agent's terminal took the request, never that the switch took. An agent may still refuse it, ask its
 * person to confirm it, or resolve the asked model to another one; what it serves afterwards is its own
 * `model:updated` and `effort:updated` evidence, and only that.
 */
export type AgentModelSwitchReceipt =
  | { status: 'sent' }
  | {
      status: 'rejected';
      reason: string;
      /** False: no later attempt can land. Absent means a later attempt may. */
      retryable?: boolean | undefined;
    };

/** What a running agent's model switch can change, so a host can offer exactly that. */
export interface AgentModelSwitchOffer {
  /** Whether the model itself can be changed. */
  readonly model: boolean;
  /** The roles of the controls that can be changed (`AgentModelControl.role`). */
  readonly controls: readonly string[];
  /**
   * How far the agent keeps a switch: `session` = this run alone; `default` = the agent also saves it as its own
   * default for the sessions it starts later. A host says so before it asks.
   */
  readonly persistence: 'session' | 'default';
}

export interface AgentModelSwitchService {
  readonly offer: AgentModelSwitchOffer;
  /**
   * Ask for one change. It sends the request whatever the agent is doing; the runtime's `Agent.switchModel` asks it
   * only of an agent it has seen idle, since a command typed into a working or asking TUI is that TUI's to interpret.
   */
  submit(request: AgentModelSwitchRequest): Promise<AgentModelSwitchReceipt>;
}
