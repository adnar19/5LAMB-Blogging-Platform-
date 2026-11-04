const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
};

// Lecture paresseuse : les variables sont resolues a l'usage (pratique pour les tests).
export const config = {
  get postsTable() {
    return required('POSTS_TABLE');
  },
  get commentsTable() {
    return required('COMMENTS_TABLE');
  },
  get mediaTable() {
    return required('MEDIA_TABLE');
  },
  get searchTable() {
    return required('SEARCH_TABLE');
  },
  get mediaBucket() {
    return required('MEDIA_BUCKET');
  },
  get userPoolId() {
    return required('USER_POOL_ID');
  },
  get userPoolClientId() {
    return required('USER_POOL_CLIENT_ID');
  },
  get newPostTopicArn() {
    return required('NEW_POST_TOPIC_ARN');
  },
  get siteUrl() {
    return (process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  },
};

export const LIMITS = Object.freeze({
  maxBodyBytes: 1_000_000,
  presignedUrlTtlSeconds: 300,
  mediaUrlTtlSeconds: 3600,
  maxSearchTerms: 5,
  maxIndexedTermsPerPost: 200,
});
