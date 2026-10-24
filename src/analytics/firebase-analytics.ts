/**
 * Firebase Analytics Module
 * Provides cloud-based analytics storage with Firebase Realtime Database
 * Falls back to local file storage if Firebase is not configured
 */

import { initializeApp, cert, App, ServiceAccount } from 'firebase-admin/app';
import { getDatabase, Database, Reference } from 'firebase-admin/database';
import fs from 'fs';
import path from 'path';

export interface Analytics {
  serverStartTime: string;
  totalRequests: number;
  totalToolCalls: number;
  requestsByMethod: Record<string, number>;
  requestsByEndpoint: Record<string, number>;
  toolCalls: Record<string, number>;
  recentToolCalls: Array<{
    tool: string;
    timestamp: string;
    /** sha256 prefix — raw IPs are never stored */
    clientIp: string;
    userAgent: string;
  }>;
  clientsByIp: Record<string, number>;
  clientsByUserAgent: Record<string, number>;
  hourlyRequests: Record<string, number>;
}

export class FirebaseAnalytics {
  private app: App | null = null;
  private db: Database | null = null;
  private ref: Reference | null = null;
  private serverName: string;
  private initialized: boolean = false;

  constructor(serverName: string) {
    this.serverName = serverName;
    this.initialize();
  }

  private initialize(): void {
    try {
      // Look for Firebase credentials
      const credentialPaths = [
        process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '',
        '/app/.credentials/firebase-service-account.json',
        path.join(process.cwd(), '.credentials', 'firebase-service-account.json'),
      ].filter(Boolean);

      let serviceAccount: ServiceAccount | null = null;
      let credPath = '';

      for (const p of credentialPaths) {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf-8');
          serviceAccount = JSON.parse(raw) as ServiceAccount;
          credPath = p;
          break;
        }
      }

      if (!serviceAccount) {
        console.log('🔥 Firebase: No credentials found, analytics will use local file only');
        return;
      }

      const databaseURL = process.env.FIREBASE_DATABASE_URL ||
        `https://${(serviceAccount as Record<string, string>).project_id}-default-rtdb.asia-southeast1.firebasedatabase.app`;

      this.app = initializeApp({
        credential: cert(serviceAccount),
        databaseURL,
      });

      this.db = getDatabase(this.app);
      this.ref = this.db.ref(`mcp-analytics/${this.serverName}`);
      this.initialized = true;

      console.log(`🔥 Firebase: Connected successfully (${credPath})`);
      console.log(`🔥 Firebase: Database URL: ${databaseURL}`);
      console.log(`🔥 Firebase: Analytics path: mcp-analytics/${this.serverName}`);
    } catch (error) {
      console.error('🔥 Firebase: Failed to initialize:', error);
      this.initialized = false;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async loadAnalytics(): Promise<Analytics | null> {
    if (!this.initialized || !this.ref) return null;

    try {
      const snapshot = await this.ref.once('value');
      const data = snapshot.val();

      if (!data) return null;

      // Provide fallback defaults for all fields (Firebase doesn't store empty objects)
      return {
        serverStartTime: data.serverStartTime || new Date().toISOString(),
        totalRequests: data.totalRequests || 0,
        totalToolCalls: data.totalToolCalls || 0,
        requestsByMethod: data.requestsByMethod || {},
        requestsByEndpoint: data.requestsByEndpoint || {},
        toolCalls: data.toolCalls || {},
        recentToolCalls: data.recentToolCalls || [],
        clientsByIp: data.clientsByIp || {},
        clientsByUserAgent: data.clientsByUserAgent || {},
        hourlyRequests: data.hourlyRequests || {},
      };
    } catch (error) {
      console.error('🔥 Firebase: Failed to load analytics:', error);
      return null;
    }
  }

  async saveAnalytics(analytics: Analytics): Promise<void> {
    if (!this.initialized || !this.ref) return;

    try {
      await this.ref.set({
        ...analytics,
        lastUpdated: new Date().toISOString(),
      });
    } catch (error) {
      console.error('🔥 Firebase: Failed to save analytics:', error);
    }
  }
}
