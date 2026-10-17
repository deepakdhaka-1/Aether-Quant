export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      account_snapshots: {
        Row: {
          broker_account_id: string
          created_at: string
          equity: number
          id: number
          user_id: string
        }
        Insert: {
          broker_account_id: string
          created_at?: string
          equity: number
          id?: never
          user_id: string
        }
        Update: {
          broker_account_id?: string
          created_at?: string
          equity?: number
          id?: never
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_snapshots_broker_account_id_fkey"
            columns: ["broker_account_id"]
            isOneToOne: false
            referencedRelation: "broker_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_snapshots_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      backtests: {
        Row: {
          created_at: string
          equity_curve: Json
          id: string
          metrics: Json
          period_end: string | null
          period_start: string | null
          strategy_id: string
          trades: Json
        }
        Insert: {
          created_at?: string
          equity_curve?: Json
          id?: string
          metrics: Json
          period_end?: string | null
          period_start?: string | null
          strategy_id: string
          trades?: Json
        }
        Update: {
          created_at?: string
          equity_curve?: Json
          id?: string
          metrics?: Json
          period_end?: string | null
          period_start?: string | null
          strategy_id?: string
          trades?: Json
        }
        Relationships: [
          {
            foreignKeyName: "backtests_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      broker_accounts: {
        Row: {
          agent_address: string
          agent_approved: boolean
          agent_key_format: string
          agent_secret_enc: string
          broker: string
          builder_approved: boolean
          builder_max_fee: string | null
          created_at: string
          id: string
          kill_switch: boolean
          last_error: string | null
          network: string
          status: string
          terms_accepted_at: string | null
          updated_at: string
          user_id: string
          wallet_address: string
          wallet_provider: string | null
        }
        Insert: {
          agent_address: string
          agent_approved?: boolean
          agent_key_format?: string
          agent_secret_enc: string
          broker?: string
          builder_approved?: boolean
          builder_max_fee?: string | null
          created_at?: string
          id?: string
          kill_switch?: boolean
          last_error?: string | null
          network?: string
          status?: string
          terms_accepted_at?: string | null
          updated_at?: string
          user_id: string
          wallet_address: string
          wallet_provider?: string | null
        }
        Update: {
          agent_address?: string
          agent_approved?: boolean
          agent_key_format?: string
          agent_secret_enc?: string
          broker?: string
          builder_approved?: boolean
          builder_max_fee?: string | null
          created_at?: string
          id?: string
          kill_switch?: boolean
          last_error?: string | null
          network?: string
          status?: string
          terms_accepted_at?: string | null
          updated_at?: string
          user_id?: string
          wallet_address?: string
          wallet_provider?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "broker_accounts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      builder_fees: {
        Row: {
          broker_account_id: string | null
          coin: string | null
          fee_usd: number
          fill_hash: string | null
          filled_at: string
          id: number
          notional: number | null
        }
        Insert: {
          broker_account_id?: string | null
          coin?: string | null
          fee_usd: number
          fill_hash?: string | null
          filled_at: string
          id?: never
          notional?: number | null
        }
        Update: {
          broker_account_id?: string | null
          coin?: string | null
          fee_usd?: number
          fill_hash?: string | null
          filled_at?: string
          id?: never
          notional?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "builder_fees_broker_account_id_fkey"
            columns: ["broker_account_id"]
            isOneToOne: false
            referencedRelation: "broker_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      exec_lock: {
        Row: {
          expires_at: string
          holder: string
          name: string
        }
        Insert: {
          expires_at: string
          holder: string
          name: string
        }
        Update: {
          expires_at?: string
          holder?: string
          name?: string
        }
        Relationships: []
      }
      heartbeats: {
        Row: {
          detail: Json | null
          id: string
          last_run: string
        }
        Insert: {
          detail?: Json | null
          id: string
          last_run?: string
        }
        Update: {
          detail?: Json | null
          id?: string
          last_run?: string
        }
        Relationships: []
      }
      markets: {
        Row: {
          active: boolean
          asset_class: string
          hl_coin: string
          max_leverage: number | null
          name: string
          symbol: string
        }
        Insert: {
          active?: boolean
          asset_class: string
          hl_coin: string
          max_leverage?: number | null
          name: string
          symbol: string
        }
        Update: {
          active?: boolean
          asset_class?: string
          hl_coin?: string
          max_leverage?: number | null
          name?: string
          symbol?: string
        }
        Relationships: []
      }
      orders: {
        Row: {
          broker_account_id: string
          broker_order_id: string | null
          builder_fee_bps10: number | null
          created_at: string
          error: string | null
          id: number
          price: number | null
          qty: number
          reduce_only: boolean
          side: string
          status: string
          strategy_id: string | null
          subscription_id: string | null
          symbol: string
          user_id: string
        }
        Insert: {
          broker_account_id: string
          broker_order_id?: string | null
          builder_fee_bps10?: number | null
          created_at?: string
          error?: string | null
          id?: never
          price?: number | null
          qty: number
          reduce_only?: boolean
          side: string
          status: string
          strategy_id?: string | null
          subscription_id?: string | null
          symbol: string
          user_id: string
        }
        Update: {
          broker_account_id?: string
          broker_order_id?: string | null
          builder_fee_bps10?: number | null
          created_at?: string
          error?: string | null
          id?: never
          price?: number | null
          qty?: number
          reduce_only?: boolean
          side?: string
          status?: string
          strategy_id?: string | null
          subscription_id?: string | null
          symbol?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_broker_account_id_fkey"
            columns: ["broker_account_id"]
            isOneToOne: false
            referencedRelation: "broker_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      positions: {
        Row: {
          broker_account_id: string
          entry_price: number | null
          mark_price: number | null
          qty: number
          side: string
          strategy_id: string | null
          symbol: string
          unrealized_pnl: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          broker_account_id: string
          entry_price?: number | null
          mark_price?: number | null
          qty: number
          side: string
          strategy_id?: string | null
          symbol: string
          unrealized_pnl?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          broker_account_id?: string
          entry_price?: number | null
          mark_price?: number | null
          qty?: number
          side?: string
          strategy_id?: string | null
          symbol?: string
          unrealized_pnl?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_broker_account_id_fkey"
            columns: ["broker_account_id"]
            isOneToOne: false
            referencedRelation: "broker_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "positions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          id: string
          referral_code: string | null
          role: string
          username: string | null
          wallet_address: string | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          id: string
          referral_code?: string | null
          role?: string
          username?: string | null
          wallet_address?: string | null
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          referral_code?: string | null
          role?: string
          username?: string | null
          wallet_address?: string | null
        }
        Relationships: []
      }
      strategies: {
        Row: {
          created_at: string
          created_by: string | null
          default_leverage: number
          description: string | null
          direction: string
          entry_long: string | null
          entry_short: string | null
          exit_long: string | null
          exit_short: string | null
          generation_meta: Json
          headline_metrics: Json
          id: string
          model_name: string | null
          name: string
          published_at: string | null
          risk_level: string
          slug: string
          source: string
          status: string
          stop_loss_pct: number | null
          symbol: string
          take_profit_pct: number | null
          timeframe: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          default_leverage?: number
          description?: string | null
          direction?: string
          entry_long?: string | null
          entry_short?: string | null
          exit_long?: string | null
          exit_short?: string | null
          generation_meta?: Json
          headline_metrics?: Json
          id?: string
          model_name?: string | null
          name: string
          published_at?: string | null
          risk_level?: string
          slug: string
          source?: string
          status?: string
          stop_loss_pct?: number | null
          symbol: string
          take_profit_pct?: number | null
          timeframe: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          default_leverage?: number
          description?: string | null
          direction?: string
          entry_long?: string | null
          entry_short?: string | null
          exit_long?: string | null
          exit_short?: string | null
          generation_meta?: Json
          headline_metrics?: Json
          id?: string
          model_name?: string | null
          name?: string
          published_at?: string | null
          risk_level?: string
          slug?: string
          source?: string
          status?: string
          stop_loss_pct?: number | null
          symbol?: string
          take_profit_pct?: number | null
          timeframe?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategies_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "strategies_symbol_fkey"
            columns: ["symbol"]
            isOneToOne: false
            referencedRelation: "markets"
            referencedColumns: ["symbol"]
          },
        ]
      }
      strategy_signals: {
        Row: {
          bar_time: string
          created_at: string
          desired: string
          id: number
          price: number | null
          reason: string | null
          strategy_id: string
        }
        Insert: {
          bar_time: string
          created_at?: string
          desired: string
          id?: never
          price?: number | null
          reason?: string | null
          strategy_id: string
        }
        Update: {
          bar_time?: string
          created_at?: string
          desired?: string
          id?: never
          price?: number | null
          reason?: string | null
          strategy_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategy_signals_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          allocation_pct: number
          broker_account_id: string
          created_at: string
          enabled: boolean
          id: string
          leverage: number
          mode: string
          strategy_id: string
          user_id: string
        }
        Insert: {
          allocation_pct: number
          broker_account_id: string
          created_at?: string
          enabled?: boolean
          id?: string
          leverage?: number
          mode?: string
          strategy_id: string
          user_id: string
        }
        Update: {
          allocation_pct?: number
          broker_account_id?: string
          created_at?: string
          enabled?: boolean
          id?: string
          leverage?: number
          mode?: string
          strategy_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_broker_account_id_fkey"
            columns: ["broker_account_id"]
            isOneToOne: false
            referencedRelation: "broker_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_strategy_id_fkey"
            columns: ["strategy_id"]
            isOneToOne: false
            referencedRelation: "strategies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      system_state: {
        Row: {
          halted: boolean
          id: string
          note: string | null
          updated_at: string
        }
        Insert: {
          halted?: boolean
          id?: string
          note?: string | null
          updated_at?: string
        }
        Update: {
          halted?: boolean
          id?: string
          note?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      user_risk: {
        Row: {
          max_daily_loss_pct: number
          max_drawdown_pct: number
          max_gross_leverage: number
          trading_enabled: boolean
          user_id: string
        }
        Insert: {
          max_daily_loss_pct?: number
          max_drawdown_pct?: number
          max_gross_leverage?: number
          trading_enabled?: boolean
          user_id: string
        }
        Update: {
          max_daily_loss_pct?: number
          max_drawdown_pct?: number
          max_gross_leverage?: number
          trading_enabled?: boolean
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_risk_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      wallet_nonces: {
        Row: {
          expires_at: string
          id: string
          issued_at: string
          nonce: string
          wallet_address: string
        }
        Insert: {
          expires_at?: string
          id?: string
          issued_at?: string
          nonce: string
          wallet_address: string
        }
        Update: {
          expires_at?: string
          id?: string
          issued_at?: string
          nonce?: string
          wallet_address?: string
        }
        Relationships: []
      }
    }
    Views: {
      revenue_daily: {
        Row: {
          day: string | null
          fee_usd: number | null
          fills: number | null
          notional_usd: number | null
          paying_accounts: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      is_admin: { Args: never; Returns: boolean }
      is_privileged_caller: { Args: never; Returns: boolean }
      my_portfolio_summary: {
        Args: never
        Returns: {
          broker_accounts: number
          equity_as_of: string
          followed_strategies: number
          open_positions: number
          total_equity: number
          unrealized_pnl: number
        }[]
      }
      prune_account_snapshots: {
        Args: { p_full_days?: number }
        Returns: number
      }
      release_exec_lock: {
        Args: { p_holder: string; p_name: string }
        Returns: undefined
      }
      strategy_leaderboard: {
        Args: never
        Returns: {
          asset_class: string
          default_leverage: number
          description: string
          direction: string
          follower_count: number
          headline_metrics: Json
          id: string
          live_follower_count: number
          market_name: string
          name: string
          published_at: string
          risk_level: string
          slug: string
          status: string
          symbol: string
          timeframe: string
        }[]
      }
      try_exec_lock: {
        Args: { p_holder: string; p_name: string; p_ttl_s: number }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
