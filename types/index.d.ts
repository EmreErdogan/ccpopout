/** The multiplexer pane running the popout program, and the pane it split from. */
export type SidePane = {
  mux: 'herdr' | 'tmux'
  id: string
  from: string
  direction: 'right' | 'down'
}

declare module 'claude-code' {
  interface PluginState {
    ccpopout: {
      turnIndex: number
      scrollRows: number
      isPromptExpanded: boolean
      isHelpShown: boolean
      isClean: boolean
      cursorItem: number
      notice: string
      turnOpen: StateFamily<boolean>
      sidePane: SidePane | null
    }
  }
}
