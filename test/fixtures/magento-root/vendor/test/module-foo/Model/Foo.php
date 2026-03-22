<?php

namespace Test\Foo\Model;

use Test\Foo\Api\FooInterface;

class Foo implements FooInterface
{
    public function save(): void {}
    public function getName(): string { return ''; }
    public function load(): self { return $this; }
    public function delete(): void {}
}
