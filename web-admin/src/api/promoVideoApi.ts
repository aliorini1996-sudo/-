import api from './client';

// أنواع لوحة الفيديوهات الترويجية — تطابق backend/src/services/promoVideoService.ts
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface VideoFeature {
  id: string;
  nameAr: string;
  duration: number;
  script: string;
  icon: string;
  enabled: boolean;
}

export interface VideoJob {
  id: string;
  featureId: string;
  featureName: string;
  status: JobStatus;
  stage: string;
  stageLabel: string;
  progress: number;
  simulated: boolean;
  voiceLabel: string;
  createdAt: string;
  completedAt?: string;
  outputUrl?: string;
  audioUrl?: string;
  error?: string;
}

export interface Voice {
  id: string;
  label: string;
  engine: 'edge' | 'google';
  name: string;
}

export interface PromoStats {
  total: number;
  completed: number;
  processing: number;
  failed: number;
  providers: { edge: boolean; google: boolean; avatar: boolean; tts: boolean };
}

// baseURL يتضمّن /api بالفعل — المسارات هنا نسبية له
export const promoVideoApi = {
  features: () => api.get('/promo-videos/features'),
  voices: () => api.get('/promo-videos/voices'),
  updateFeature: (id: string, data: { script?: string; duration?: number; enabled?: boolean }) =>
    api.put(`/promo-videos/features/${id}`, data),
  jobs: () => api.get('/promo-videos/jobs'),
  generate: (featureId: string, voiceId?: string) => api.post('/promo-videos/generate', { featureId, voiceId }),
  generateBatch: (featureIds: string[], voiceId?: string) => api.post('/promo-videos/generate-batch', { featureIds, voiceId }),
  removeJob: (id: string) => api.delete(`/promo-videos/jobs/${id}`),
  stats: () => api.get('/promo-videos/stats'),
};
