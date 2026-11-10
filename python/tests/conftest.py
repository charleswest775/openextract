def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "fake_iphone: the whole backup path against a scripted fake iPhone (python/tests/fake_iphone)",
    )
