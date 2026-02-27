def is_prime(n):
    if n <= 1:
        return False
    for i in range(2, int(n**0.5) + 1):
        if n % i == 0:
            return False
    return True

if __name__ == "__main__":
    primes = [n for n in range(1, 101) if is_prime(n)]
    print(f"Numerele prime până la 100 sunt: {primes}")
