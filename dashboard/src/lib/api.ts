import type { ApiResponse, ApiError, AuthStatus, HealthStatus, DashboardStats, Server, ServersResponse, QueueEntry, QueueEntriesResponse, Account, Proxy, AccountImportResult, ProxyImportResult, ServerDetail, Agent } from './types';

const API_BASE = import.meta.env.API_BASE || '';

class ApiClient {
  private baseUrl: string;
  private apiKey: string | null = null;

  constructor(baseUrl: string = API_BASE) {
    this.baseUrl = baseUrl;
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('reconmc_api_key');
      if (stored) {
        this.apiKey = stored;
      }
    }
  }

  setApiKey(key: string | null) {
    this.apiKey = key;
    if (typeof window !== 'undefined') {
      if (key) {
        localStorage.setItem('reconmc_api_key', key);
      } else {
        localStorage.removeItem('reconmc_api_key');
      }
    }
  }

  getApiKey(): string | null {
    return this.apiKey;
  }

  private getHeaders(hasBody: boolean = true): HeadersInit {
    const headers: HeadersInit = {};
    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }
    return headers;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
    hasBody: boolean = true
  ): Promise<ApiResponse<T>> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: {
          ...this.getHeaders(hasBody),
          ...options.headers,
        },
      });

      // Handle empty responses (204 No Content)
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;

      if (!response.ok) {
        const error = data as ApiError;
        return { error: error?.error || error?.message || `Request failed (${response.status})` };
      }

      return { data: data as T };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error';
      return { error: message };
    }
  }

  async get<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>(path, { method: 'GET' }, false);
  }

  async post<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    }, !!body);
  }

  async put<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(path, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    }, !!body);
  }

  async delete<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>(path, { method: 'DELETE' }, false);
  }

  async getHealth(): Promise<ApiResponse<HealthStatus>> {
    return this.get<HealthStatus>('/api/health');
  }

  async getAuthStatus(): Promise<ApiResponse<AuthStatus>> {
    return this.get<AuthStatus>('/api/auth/status');
  }

  async getDashboardStats(): Promise<ApiResponse<DashboardStats>> {
    return this.get<DashboardStats>('/api/dashboard/stats');
  }

  async getServers(limit = 100, offset = 0): Promise<ApiResponse<Server[]>> {
    return this.get<Server[]>(`/api/servers?limit=${limit}&offset=${offset}`);
  }

  async getServersWithPagination(limit = 100, offset = 0): Promise<ApiResponse<ServersResponse>> {
    return this.get<ServersResponse>(`/api/servers/search?limit=${limit}&offset=${offset}`);
  }

  async deleteServer(id: string): Promise<ApiResponse<{ message: string }>> {
    return this.delete<{ message: string }>(`/api/servers/${id}`);
  }

  async addToQueue(servers: string[]): Promise<ApiResponse<{ added: number; skipped: number; queued: Array<{ id: string; serverAddress: string }> }>> {
    return this.post<{ added: number; skipped: number; queued: Array<{ id: string; serverAddress: string }> }>('/api/servers/add', { servers });
  }

  async getQueueEntries(status = 'all', limit = 100, offset = 0): Promise<ApiResponse<QueueEntry[]>> {
    return this.get<QueueEntry[]>(`/api/queue/entries?status=${status}&limit=${limit}&offset=${offset}`);
  }

  async getAccounts(): Promise<ApiResponse<Account[]>> {
    return this.get<Account[]>('/api/accounts');
  }

  async createAccount(data: { type: string; username?: string; accessToken?: string; refreshToken?: string; maxConcurrent?: number }): Promise<ApiResponse<Account>> {
    return this.post<Account>('/api/accounts', data);
  }

  async updateAccount(id: string, data: Partial<{ username: string; accessToken: string; refreshToken: string; isActive: boolean; maxConcurrent: number }>): Promise<ApiResponse<Account>> {
    return this.put<Account>(`/api/accounts/${id}`, data);
  }

  async deleteAccount(id: string): Promise<ApiResponse<void>> {
    return this.delete<void>(`/api/accounts/${id}`);
  }

  async validateAccount(id: string): Promise<ApiResponse<{ valid: boolean; username?: string; error?: string; account: Account }>> {
    return this.post<{ valid: boolean; username?: string; error?: string; account: Account }>(`/api/accounts/${id}/validate`);
  }

  async importAccounts(accounts: Array<{ type: string; username?: string; accessToken?: string; refreshToken?: string }>): Promise<ApiResponse<AccountImportResult>> {
    return this.post<AccountImportResult>('/api/accounts/import', { accounts });
  }

  async exportAccounts(): Promise<ApiResponse<Array<{ type: string; username?: string; accessToken?: string; refreshToken?: string; maxConcurrent: number }>>> {
    return this.get<Array<{ type: string; username?: string; accessToken?: string; refreshToken?: string; maxConcurrent: number }>>('/api/accounts/export');
  }

  async getProxies(): Promise<ApiResponse<Proxy[]>> {
    return this.get<Proxy[]>('/api/proxies');
  }

  async createProxy(data: { host: string; port: number; username?: string; password?: string; protocol?: string; maxConcurrent?: number }): Promise<ApiResponse<Proxy>> {
    return this.post<Proxy>('/api/proxies', data);
  }

  async updateProxy(id: string, data: Partial<{ host: string; port: number; username: string; password: string; isActive: boolean; maxConcurrent: number }>): Promise<ApiResponse<Proxy>> {
    return this.put<Proxy>(`/api/proxies/${id}`, data);
  }

  async deleteProxy(id: string): Promise<ApiResponse<void>> {
    return this.delete<void>(`/api/proxies/${id}`);
  }

  async importProxies(content: string): Promise<ApiResponse<ProxyImportResult>> {
    return this.post<ProxyImportResult>('/api/proxies/import', { content });
  }

  async exportProxies(): Promise<ApiResponse<Array<{ host: string; port: number; username?: string; password?: string; protocol: string; maxConcurrent: number }>>> {
    return this.get<Array<{ host: string; port: number; username?: string; password?: string; protocol: string; maxConcurrent: number }>>('/api/proxies/export');
  }

  async getServer(id: string): Promise<ApiResponse<ServerDetail>> {
    return this.get<ServerDetail>(`/api/servers/${id}`);
  }

  async deleteScan(serverId: string, timestamp: string): Promise<ApiResponse<{ message: string }>> {
    return this.delete<{ message: string }>(`/api/servers/${serverId}/scan/${encodeURIComponent(timestamp)}`);
  }

  async cancelQueueEntry(id: string): Promise<ApiResponse<void>> {
    return this.delete<void>(`/api/queue/${id}`);
  }

  async getAgents(): Promise<ApiResponse<Agent[]>> {
    return this.get<Agent[]>('/api/agents');
  }
}

export const api = new ApiClient();
export { ApiClient };
