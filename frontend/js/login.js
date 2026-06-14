import Alpine from 'alpinejs';

document.addEventListener('alpine:init', () => {
  Alpine.data('loginForm', () => ({
    username: '',
    password: '',
    loading: false,
    error: null,

    async login() {
      this.loading = true;
      this.error = null;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: this.username, password: this.password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Login failed');
        window.location.href = '/';
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
  }));
});

Alpine.start();
