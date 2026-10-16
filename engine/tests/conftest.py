import os
import sys

# Make `import aether` work no matter which directory pytest is launched from.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
